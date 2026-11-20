import { useEffect, useRef, useState, type FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  Activity,
  ArrowDownToLine,
  BatteryCharging,
  BatteryWarning,
  Camera,
  Check,
  CheckCheck,
  ChevronDown,
  CircleDot,
  Copy,
  ExternalLink,
  FlipHorizontal2,
  Gauge,
  Link2,
  LockKeyhole,
  Maximize,
  MonitorSmartphone,
  Radio,
  RefreshCw,
  ScanEye,
  ShieldCheck,
  Signal,
  Smartphone,
  Video,
  VideoOff,
  Wifi,
  WifiOff,
  X,
  Zap,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { createRoomToken, createViewerLink, parseRoomToken } from "@/lib/camera-room";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Keepwatch — Private live camera" },
      { name: "description", content: "Turn your phone into a private live camera. Watch from anywhere, check its battery, and reconnect automatically." },
      { property: "og:title", content: "Keepwatch — Private live camera" },
      { property: "og:description", content: "A private live camera and device monitor for the places that matter." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Keepwatch,
});

type AppMode = "camera" | "viewer";
type ConnectionStatus = "offline" | "connecting" | "connected" | "retrying";
type BatteryInfo = { level: number; charging: boolean } | null;
type NetworkInfo = Navigator & {
  connection?: EventTarget & { effectiveType?: string; type?: string };
  getBattery?: () => Promise<EventTarget & { level: number; charging: boolean }>;
};
type SignalMessage = {
  kind?: string;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  battery?: BatteryInfo;
  size?: string;
  charging?: boolean;
};

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function Keepwatch() {
  const [mode, setMode] = useState<AppMode>("camera");
  const [room, setRoom] = useState<string | null>(null);
  const [viewerInput, setViewerInput] = useState("");
  const [cameraActive, setCameraActive] = useState(false);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [cameraError, setCameraError] = useState("");
  const [viewerError, setViewerError] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>("offline");
  const [copied, setCopied] = useState(false);
  const [online, setOnline] = useState(true);
  const [battery, setBattery] = useState<BatteryInfo>(null);
  const [batterySupported, setBatterySupported] = useState(true);
  const [networkType, setNetworkType] = useState("Network");
  const [streamSize, setStreamSize] = useState("—");
  const [remoteBattery, setRemoteBattery] = useState<BatteryInfo>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const candidateQueueRef = useRef<RTCIceCandidateInit[]>([]);
  const lastWatchRequestRef = useRef(0);
  const peerStartedRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);

  const viewerLink = room ? createViewerLink(window.location.origin, room) : "";
  const viewerIsConnected = mode === "viewer" && status === "connected";

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("room");
    if (!token) return;
    const parsed = parseRoomToken(token);
    if (!parsed) {
      setViewerError("This viewing link is not valid. Ask the camera owner for a new link.");
      return;
    }
    setRoom(parsed);
    setViewerInput(window.location.href);
    setMode("viewer");
  }, []);

  useEffect(() => {
    const syncNetwork = () => setOnline(navigator.onLine);
    const connection = (navigator as NetworkInfo).connection;
    const syncType = () => {
      setNetworkType(connection?.effectiveType ?? connection?.type ?? "Network");
    };

    syncNetwork();
    syncType();
    window.addEventListener("online", syncNetwork);
    window.addEventListener("offline", syncNetwork);
    connection?.addEventListener("change", syncType);

    let batteryDevice: EventTarget & { level: number; charging: boolean } | null = null;
    let mounted = true;
    const syncBattery = () => {
      if (batteryDevice && mounted) {
        setBattery({ level: Math.round(batteryDevice.level * 100), charging: batteryDevice.charging });
      }
    };
    const batteryApi = (navigator as NetworkInfo).getBattery;
    if (batteryApi) {
      batteryApi.call(navigator).then((device) => {
        if (!mounted) return;
        batteryDevice = device;
        syncBattery();
        batteryDevice.addEventListener("levelchange", syncBattery);
        batteryDevice.addEventListener("chargingchange", syncBattery);
      }).catch(() => setBatterySupported(false));
    } else {
      setBatterySupported(false);
    }

    return () => {
      mounted = false;
      window.removeEventListener("online", syncNetwork);
      window.removeEventListener("offline", syncNetwork);
      connection?.removeEventListener("change", syncType);
      batteryDevice?.removeEventListener("levelchange", syncBattery);
      batteryDevice?.removeEventListener("chargingchange", syncBattery);
    };
  }, []);

  useEffect(() => {
    if (cameraActive && localVideoRef.current) localVideoRef.current.srcObject = cameraStreamRef.current;
  }, [cameraActive, mode]);

  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
  }, [remoteStream, mode]);

  useEffect(() => {
    if (!cameraActive) {
      setElapsed(0);
      return;
    }
    const tick = () => setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [cameraActive]);

  useEffect(() => {
    if (!room || (mode === "camera" && !cameraActive)) return;
    let cancelled = false;
    let localChannel: ReturnType<typeof supabase.channel> | null = null;
    let connectionRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

    const sendSignal = async (payload: Record<string, unknown>) => {
      if (!localChannel || localChannel.state !== "joined") return;
      try {
        await localChannel.send({ type: "broadcast", event: "signal", payload });
      } catch {
        if (!cancelled) setStatus("retrying");
      }
    };

    const stopPeer = () => {
      if (connectionRecoveryTimer) window.clearTimeout(connectionRecoveryTimer);
      connectionRecoveryTimer = null;
      peerRef.current?.close();
      peerRef.current = null;
      candidateQueueRef.current = [];
    };

    const makePeer = (role: AppMode) => {
      stopPeer();
      const peer = new RTCPeerConnection(ICE_SERVERS);
      peerRef.current = peer;
      peerStartedRef.current = Date.now();
      candidateQueueRef.current = [];
      peer.onicecandidate = (event) => {
        if (event.candidate && peerRef.current === peer) {
          void sendSignal({ kind: "ice", candidate: event.candidate.toJSON() });
        }
      };
      peer.onconnectionstatechange = () => {
        if (peerRef.current !== peer) return;
        if (peer.connectionState === "connected") {
          if (connectionRecoveryTimer) window.clearTimeout(connectionRecoveryTimer);
          connectionRecoveryTimer = null;
          setStatus("connected");
          setViewerError("");
          return;
        }
        if (peer.connectionState === "connecting" || peer.connectionState === "new") {
          setStatus("connecting");
        }
        if (peer.connectionState === "disconnected") {
          setStatus("retrying");
          if (connectionRecoveryTimer) window.clearTimeout(connectionRecoveryTimer);
          connectionRecoveryTimer = window.setTimeout(() => {
            if (peerRef.current === peer && peer.connectionState !== "connected") stopPeer();
          }, 4500);
        }
        if (peer.connectionState === "failed" || peer.connectionState === "closed") {
          setStatus("retrying");
        }
      };
      peer.oniceconnectionstatechange = () => {
        if (peer.iceConnectionState === "failed") {
          void peer.restartIce?.();
        }
      };
      if (role === "viewer") {
        peer.ontrack = (event) => {
          const [receivedStream] = event.streams;
          if (receivedStream) {
            setRemoteStream(receivedStream);
          } else {
            const singleTrackStream = new MediaStream([event.track]);
            setRemoteStream(singleTrackStream);
          }
        };
      } else {
        cameraStreamRef.current?.getTracks().forEach((track) => peer.addTrack(track, cameraStreamRef.current as MediaStream));
      }
      return peer;
    };

    const sendViewerRequest = () => {
      const now = Date.now();
      if (now - lastWatchRequestRef.current < 3000 || !online || !localChannel || localChannel.state !== "joined") return;
      lastWatchRequestRef.current = now;
      void sendSignal({ kind: "watch" });
    };

    localChannel = supabase.channel(`keepwatch-${room}`, {
      config: { broadcast: { self: false } },
    });
    channelRef.current = localChannel;

    localChannel.on("broadcast", { event: "signal" }, ({ payload }) => {
      if (cancelled) return;
      const message = payload as SignalMessage;

      if (message.kind === "camera-status" && mode === "viewer") {
        const camera = message.battery;
        setRemoteBattery(camera && typeof camera.level === "number" ? camera : null);
        if (typeof message.size === "string") setStreamSize(message.size);
        if (status === "offline") setStatus("connecting");
        return;
      }

      if (message.kind === "watch" && mode === "camera" && cameraActive) {
        const existingPeer = peerRef.current;
        if (existingPeer && existingPeer.connectionState !== "closed") {
          const connectingTooLong = Date.now() - peerStartedRef.current > 12000;
          if (existingPeer.connectionState === "connected" || !connectingTooLong) return;
        }
        const peer = makePeer("camera");
        setStatus("connecting");
        void peer.createOffer().then(async (offer) => {
          if (peerRef.current !== peer) return;
          await peer.setLocalDescription(offer);
          await sendSignal({ kind: "offer", description: offer });
        }).catch(() => setStatus("retrying"));
        return;
      }

      if (message.kind === "offer" && mode === "viewer" && message.description) {
        const peer = makePeer("viewer");
        setStatus("connecting");
        void peer.setRemoteDescription(message.description).then(async () => {
          for (const candidate of candidateQueueRef.current.splice(0)) {
            await peer.addIceCandidate(candidate).catch(() => undefined);
          }
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          await sendSignal({ kind: "answer", description: answer });
        }).catch(() => {
          setViewerError("Couldn’t open the live feed. Reconnecting now.");
          setStatus("retrying");
        });
        return;
      }

      if (message.kind === "answer" && mode === "camera" && message.description && peerRef.current) {
        const peer = peerRef.current;
        void peer.setRemoteDescription(message.description).then(async () => {
          for (const candidate of candidateQueueRef.current.splice(0)) {
            await peer.addIceCandidate(candidate).catch(() => undefined);
          }
        }).catch(() => setStatus("retrying"));
        return;
      }

      if (message.kind === "ice" && message.candidate && peerRef.current) {
        const peer = peerRef.current;
        if (!peer.remoteDescription) {
          candidateQueueRef.current.push(message.candidate);
        } else {
          void peer.addIceCandidate(message.candidate).catch(() => undefined);
        }
      }
    });

    localChannel.subscribe((channelStatus) => {
      if (cancelled) return;
      if (channelStatus === "SUBSCRIBED") {
        setStatus(mode === "viewer" ? "connecting" : "offline");
        if (mode === "viewer") {
          lastWatchRequestRef.current = 0;
          sendViewerRequest();
        }
      }
      if (channelStatus === "CHANNEL_ERROR" || channelStatus === "TIMED_OUT" || channelStatus === "CLOSED") {
        setStatus("retrying");
      }
    });

    if (mode === "camera" && cameraActive) {
      const publishCameraDetails = () => {
        if (cancelled || !localChannel || localChannel.state !== "joined") return;
        const track = cameraStreamRef.current?.getVideoTracks()[0];
        const dimensions = track?.getSettings();
        const size = dimensions?.width && dimensions.height ? `${dimensions.width} × ${dimensions.height}` : "Live";
        setStreamSize(size);
        void sendSignal({ kind: "camera-status", battery, size });
      };
      const statusTimer = window.setInterval(publishCameraDetails, 12000);
      localChannel.on("broadcast", { event: "signal" }, ({ payload }) => {
        if ((payload as SignalMessage).kind === "watch") publishCameraDetails();
      });
      localChannel.subscribe((channelStatus) => {
        if (channelStatus === "SUBSCRIBED") publishCameraDetails();
      });
      retryTimerRef.current = statusTimer;
    }

    const handleOnline = () => {
      setOnline(true);
      if (mode === "viewer") {
        lastWatchRequestRef.current = 0;
        window.setTimeout(sendViewerRequest, 700);
      }
    };
    const handleOffline = () => {
      setOnline(false);
      setStatus("retrying");
    };
    const requestFocusReconnect = () => {
      if (document.visibilityState === "visible" && mode === "viewer") {
        lastWatchRequestRef.current = 0;
        sendViewerRequest();
      }
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", requestFocusReconnect);

    if (mode === "viewer") {
      retryTimerRef.current = window.setInterval(() => {
        if (!online) return;
        const peer = peerRef.current;
        if (!peer || peer.connectionState !== "connected") {
          if (!peer || Date.now() - lastWatchRequestRef.current >= 7000) {
            if (peer && Date.now() - peerStartedRef.current > 9000) stopPeer();
            sendViewerRequest();
          }
        }
      }, 2500);
    }

    return () => {
      cancelled = true;
      if (retryTimerRef.current) window.clearInterval(retryTimerRef.current);
      retryTimerRef.current = null;
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", requestFocusReconnect);
      stopPeer();
      setRemoteStream(null);
      if (channelRef.current === localChannel) channelRef.current = null;
      if (localChannel) void supabase.removeChannel(localChannel);
    };
  }, [room, mode, cameraActive, online, battery]);

  async function startCamera() {
    setCameraError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Camera access requires a secure website (HTTPS) and a supported browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
      });
      cameraStreamRef.current = stream;
      startedAtRef.current = Date.now();
      const token = createRoomToken();
      window.history.replaceState({}, "", `${window.location.pathname}?room=${token}`);
      setRoom(token);
      setCameraActive(true);
      const track = stream.getVideoTracks()[0];
      const dimensions = track?.getSettings();
      if (dimensions?.width && dimensions.height) setStreamSize(`${dimensions.width} × ${dimensions.height}`);
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setCameraError("Camera permission is blocked. Allow camera access in your browser settings, then try again.");
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setCameraError("No compatible camera was found on this device.");
      } else {
        setCameraError("The camera could not start. Check that no other app is using it, then try again.");
      }
    }
  }

  function stopCamera() {
    void channelRef.current?.send({ type: "broadcast", event: "signal", payload: { kind: "camera-status", battery: null, size: "Camera paused" } });
    peerRef.current?.close();
    peerRef.current = null;
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    setCameraActive(false);
    setStatus("offline");
    setRoom(null);
    setRemoteStream(null);
    window.history.replaceState({}, "", window.location.pathname);
  }

  async function changeCamera() {
    const nextFacing = facing === "environment" ? "user" : "environment";
    setFacing(nextFacing);
    if (!cameraActive) return;
    const oldStream = cameraStreamRef.current;
    if (!navigator.mediaDevices?.getUserMedia) return;
    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: nextFacing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
      });
      cameraStreamRef.current = nextStream;
      oldStream?.getTracks().forEach((track) => track.stop());
      const nextTrack = nextStream.getVideoTracks()[0];
      const sender = peerRef.current?.getSenders().find((item) => item.track?.kind === "video");
      if (sender && nextTrack) await sender.replaceTrack(nextTrack);
      if (localVideoRef.current) localVideoRef.current.srcObject = nextStream;
    } catch {
      setFacing(facing);
      setCameraError("Couldn’t switch cameras. Your current camera is still on.");
    }
  }

  async function handleCopyLink() {
    if (!viewerLink) return;
    try {
      await navigator.clipboard.writeText(viewerLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      inputRef.current?.focus();
      inputRef.current?.select();
      setCameraError("Copy isn’t available here. Select the highlighted link and copy it instead.");
    }
  }

  function openViewer() {
    if (cameraActive) stopCamera();
    setMode("viewer");
    setViewerError("");
    setViewerInput("");
  }

  function submitViewer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = parseRoomToken(viewerInput);
    if (!token) {
      setViewerError("Paste a valid Keepwatch link to your camera.");
      return;
    }
    setViewerError("");
    setRemoteBattery(null);
    setStatus("connecting");
    setRoom(token);
    window.history.replaceState({}, "", `${window.location.pathname}?room=${token}`);
  }

  function openCamera() {
    setMode("camera");
    setRoom(null);
    setViewerError("");
    window.history.replaceState({}, "", window.location.pathname);
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-[1480px] flex-col px-5 pb-8 pt-4 sm:px-8 lg:px-12 lg:pt-7">
        <header className="flex min-h-14 items-center justify-between border-b border-border/80 pb-4">
          <a href="/" onClick={openCamera} className="flex items-center gap-2.5" aria-label="Keepwatch home">
            <BrandMark />
            <span className="type-display text-[19px] font-semibold tracking-[0]">keepwatch<span className="text-primary">.</span></span>
          </a>
          <div className="flex items-center gap-2">
            <span className={`relative flex size-2 rounded-full ${online ? "bg-[var(--signal)]" : "bg-[var(--coral)]"}`} />
            <span className="mono-data text-[11px] uppercase tracking-[0] text-muted-foreground">{online ? "Network ready" : "Reconnecting"}</span>
            <span className="mx-1 h-5 w-px bg-border" />
            <Button
              variant="outline"
              size="sm"
              onClick={() => mode === "camera" ? openViewer() : openCamera()}
              className="h-9 rounded-sm border-border px-3 text-xs text-foreground"
            >
              {mode === "camera" ? <><ScanEye className="mr-1.5 size-3.5" /> Watch a camera</> : <><Camera className="mr-1.5 size-3.5" /> Camera</>}
            </Button>
          </div>
        </header>

        <div className="grid flex-1 grid-cols-1 gap-8 pt-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-11 lg:pt-10">
          <section className="min-w-0">
            <div className="mb-5 flex items-center justify-between gap-4">
              <div>
                <div className="mono-data mb-1.5 flex items-center gap-2 text-[10px] uppercase text-muted-foreground">
                  <span className="text-primary">{mode === "camera" ? "01" : "02"}</span>
                  <span className="h-px w-5 bg-border" />
                  {mode === "camera" ? "CAMERA STATION" : "LIVE MONITOR"}
                </div>
                <h1 className="type-display text-3xl font-semibold leading-tight sm:text-[34px]">
                  {mode === "camera" ? "Your camera" : "Camera monitor"}
                </h1>
              </div>
              {mode === "camera" && cameraActive && <LiveBadge label="CAMERA ON" />}
              {mode === "viewer" && <LiveBadge label={viewerIsConnected ? "LIVE FEED" : "MONITOR"} active={viewerIsConnected} />}
            </div>

            <section className="relative isolate aspect-[4/3] overflow-hidden rounded-[3px] border border-border bg-[var(--feed-stage)] sm:aspect-[16/9] lg:max-h-[580px]" aria-label={mode === "camera" ? "Camera preview" : "Live camera feed"}>
              <div className="absolute inset-0 feed-noise opacity-50" />
              <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_48%_46%,oklch(0.29_0.035_157_/_30%),transparent_68%)]" />
              {mode === "camera" && cameraActive && <video ref={localVideoRef} className="absolute inset-0 size-full object-cover" autoPlay playsInline muted aria-label="Live camera preview" />}
              {mode === "viewer" && remoteStream && <video ref={remoteVideoRef} className="absolute inset-0 size-full object-contain" autoPlay playsInline aria-label="Live camera feed" />}

              {((mode === "camera" && !cameraActive) || (mode === "viewer" && !remoteStream)) && (
                <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
                  <div className="mb-5 flex size-[76px] items-center justify-center rounded-full border border-primary/20 bg-primary/[0.07]">
                    {mode === "camera" ? <Camera className="size-8 text-primary/80" strokeWidth={1.3} /> : <MonitorSmartphone className="size-8 text-primary/80" strokeWidth={1.3} />}
                  </div>
                  <p className="type-display text-lg font-medium">
                    {mode === "camera" ? "Nothing in view. Yet." : !room ? "A familiar place, from anywhere." : status === "retrying" ? "Finding your camera…" : "Waiting for your camera…"}
                  </p>
                  <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                    {mode === "camera" ? "Turn this phone into a private live camera in one tap." : !room ? "Add a camera link to start a secure live view." : status === "retrying" ? "We’ll reconnect automatically as soon as the connection is back." : "The live feed will appear as soon as the camera is ready."}
                  </p>
                  {mode === "camera" && (
                    <Button onClick={() => void startCamera()} className="mt-6 h-11 rounded-[3px] px-6 text-sm font-semibold" disabled={!online}>
                      <Video className="mr-2 size-4" /> Start camera
                    </Button>
                  )}
                  {mode === "viewer" && !room && (
                    <Button variant="outline" onClick={() => inputRef.current?.focus()} className="mt-6 h-10 rounded-[3px] px-5 text-sm">
                      <Link2 className="mr-2 size-4" /> Add camera link
                    </Button>
                  )}
                  {mode === "viewer" && room && (
                    <div className="mono-data mt-6 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="size-1.5 animate-pulse rounded-full bg-[var(--coral)]" />
                      {online ? "Reconnecting automatically" : "Waiting for internet"}
                    </div>
                  )}
                  {cameraError && mode === "camera" && (
                    <div role="alert" className="mt-4 max-w-md text-sm text-[var(--coral)]">{cameraError}</div>
                  )}
                  {viewerError && mode === "viewer" && (
                    <div role="alert" className="mt-4 max-w-md text-sm text-[var(--coral)]">{viewerError}</div>
                  )}
                </div>
              )}

              <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-3 p-3.5 sm:p-5">
                <div className="flex items-center gap-2">
                  {mode === "camera" && cameraActive && <OnAirChip />}
                  {mode === "viewer" && remoteStream && <OnAirChip />}
                  {mode === "viewer" && !room && <span className="rounded-sm border border-border/80 bg-background/75 px-2 py-1 text-[10px] uppercase text-muted-foreground">Awaiting link</span>}
                </div>
                <span className="mono-data rounded-sm border border-border/70 bg-background/75 px-2.5 py-1 text-[10px] text-foreground/75 backdrop-blur-sm">{mode === "camera" && cameraActive ? formatDuration(elapsed) : mode === "viewer" && remoteStream ? streamSize : "KEEPWATCH · 01"}</span>
              </div>
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between border-t border-border/60 bg-background/60 px-3.5 py-2.5 backdrop-blur-sm sm:px-5">
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  {online ? <Wifi className="size-3.5 text-[var(--signal)]" /> : <WifiOff className="size-3.5 text-[var(--coral)]" />}
                  <span>{online ? `${networkType} · encrypted connection` : "Connection interrupted · retrying"}</span>
                </div>
                <span className="mono-data hidden text-[10px] text-muted-foreground sm:block">{mode === "camera" ? streamSize : viewerIsConnected ? "PEER TO PEER" : "READY TO CONNECT"}</span>
              </div>
            </section>

            {mode === "camera" ? (
              <div className="mt-5">
                <div className="flex flex-col gap-4 border-b border-border/80 pb-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className={`mt-1.5 size-2 shrink-0 rounded-full ${cameraActive ? "animate-pulse bg-[var(--signal)]" : "bg-muted-foreground/45"}`} />
                    <div>
                      <p className="text-sm font-medium">{cameraActive ? "Your camera is running" : "Ready when you are"}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{cameraActive ? "This phone is securely streaming to your link." : "The camera only streams while you choose to leave it on."}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {cameraActive ? (
                      <>
                        <Button variant="outline" onClick={() => void changeCamera()} className="h-9 rounded-[3px] px-3 text-xs"><FlipHorizontal2 className="mr-1.5 size-3.5" /> Flip</Button>
                        <Button variant="destructive" onClick={stopCamera} className="h-9 rounded-[3px] px-3 text-xs"><VideoOff className="mr-1.5 size-3.5" /> Stop camera</Button>
                      </>
                    ) : (
                      <Button onClick={() => void startCamera()} disabled={!online} className="h-9 rounded-[3px] px-4 text-xs"><Video className="mr-1.5 size-3.5" /> Start camera</Button>
                    )}
                  </div>
                </div>

                {cameraActive && room && (
                  <div className="flex flex-col gap-3 border-b border-border/80 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-start gap-3">
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-[var(--signal-muted)] text-[var(--signal)]"><Link2 className="size-4" /></div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">Private viewing link</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">Anyone with this link can view. Share it only with someone you trust.</p>
                        <Input ref={inputRef} readOnly aria-label="Private camera link" value={viewerLink} onFocus={(event) => event.currentTarget.select()} className="mono-data mt-2.5 h-8 max-w-full rounded-sm border-border bg-secondary/60 text-[10px] text-muted-foreground sm:w-[370px]" />
                      </div>
                    </div>
                    <Button variant="outline" onClick={() => void handleCopyLink()} className="h-9 w-full shrink-0 rounded-[3px] px-3 text-xs sm:w-auto">
                      {copied ? <CheckCheck className="mr-1.5 size-3.5 text-[var(--signal)]" /> : <Copy className="mr-1.5 size-3.5" />}{copied ? "Link copied" : "Copy link"}
                    </Button>
                  </div>
                )}

                <div className="flex items-start gap-2.5 py-3 text-[11px] leading-5 text-muted-foreground">
                  <LockKeyhole className="mt-0.5 size-3.5 shrink-0 text-[var(--signal)]" />
                  <p>Your video goes directly between your devices and is not saved. Keepwatch does not secretly record.</p>
                </div>
              </div>
            ) : (
              <div className="mt-5">
                <form onSubmit={submitViewer} className="flex flex-col gap-2.5 border-b border-border/80 pb-5 sm:flex-row">
                  <label htmlFor="camera-link" className="sr-only">Paste camera link</label>
                  <div className="relative flex-1">
                    <Link2 className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input ref={inputRef} id="camera-link" value={viewerInput} onChange={(event) => setViewerInput(event.target.value)} placeholder="Paste a camera viewing link" className="h-10 rounded-[3px] border-border bg-secondary/45 pl-10 text-sm" />
                  </div>
                  <Button type="submit" disabled={!online || !viewerInput.trim()} className="h-10 rounded-[3px] px-5 text-sm">Connect <ExternalLink className="ml-1.5 size-3.5" /></Button>
                </form>
                {viewerError && !remoteStream && <p role="alert" className="mt-3 text-sm text-[var(--coral)]">{viewerError}</p>}
                <div className="flex items-center justify-between gap-4 border-b border-border/80 py-4">
                  <div className="flex items-center gap-3">
                    <div className={`flex size-8 items-center justify-center rounded-sm ${viewerIsConnected ? "bg-[var(--signal-muted)] text-[var(--signal)]" : "bg-secondary text-muted-foreground"}`}>
                      {viewerIsConnected ? <CircleDot className="size-4" /> : <RefreshCw className="size-4" />}
                    </div>
                    <div>
                      <p className="text-sm font-medium">{viewerIsConnected ? "Live camera connected" : room ? status === "retrying" ? "Reconnecting to camera" : "Connecting to camera" : "Waiting for a link"}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{room ? online ? "Automatic reconnect is on." : "Waiting for your internet connection." : "Connect to a camera link you trust."}</p>
                    </div>
                  </div>
                  {room && <Button variant="ghost" size="sm" onClick={() => { setRoom(null); setViewerInput(""); setStatus("offline"); setRemoteBattery(null); setRemoteStream(null); window.history.replaceState({}, "", window.location.pathname); }} className="text-muted-foreground"><X className="mr-1.5 size-3.5" /> Disconnect</Button>}
                </div>
                <div className="flex items-start gap-2.5 py-3 text-[11px] leading-5 text-muted-foreground">
                  <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-[var(--cyan)]" />
                  <p>Only connect to a camera belonging to you or someone who has invited you.</p>
                </div>
              </div>
            )}
          </section>

          <aside className="flex flex-col gap-7 border-t border-border/80 pt-6 lg:border-l lg:border-t-0 lg:pl-7 lg:pt-0">
            <section>
              <SectionLabel index="A" title="DEVICE" />
              <div className="mt-3 divide-y divide-border/70">
                <DetailRow
                  icon={battery?.charging ? BatteryCharging : battery && battery.level <= 20 ? BatteryWarning : Activity}
                  label="Battery level"
                  value={battery ? `${battery.level}%` : batterySupported ? "Checking" : "Not available"}
                  valueTone={battery && battery.level <= 20 ? "coral" : undefined}
                  detail={battery ? battery.charging ? "Charging" : "On battery" : batterySupported ? "Phone browser may not share this" : "Device privacy setting"}
                  level={battery?.level}
                />
                <DetailRow icon={online ? Signal : WifiOff} label="Connection" value={online ? networkType.toUpperCase() : "Offline"} valueTone={online ? "signal" : "coral"} detail={online ? "Automatic reconnect on" : "Retrying automatically"} />
                <DetailRow icon={Camera} label="Camera status" value={cameraActive ? "Active" : "Standby"} valueTone={cameraActive ? "signal" : undefined} detail={cameraActive ? streamSize : "Starts only when you tap"} />
                <DetailRow icon={Zap} label="Stream quality" value={cameraActive ? "HD" : "Ready"} detail={cameraActive ? "Up to 720p · peer to peer" : "Up to 720p · no recording"} />
              </div>
            </section>

            <section className="border-t border-border/80 pt-5">
              <SectionLabel index="B" title="CONNECTION" />
              <div className="mt-3 flex items-start gap-3">
                <div className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-sm ${status === "connected" ? "bg-[var(--signal-muted)] text-[var(--signal)]" : "bg-secondary text-muted-foreground"}`}>
                  {status === "connected" ? <Radio className="size-4" /> : online ? <Wifi className="size-4" /> : <WifiOff className="size-4" />}
                </div>
                <div>
                  <p className="text-sm font-medium">{connectionLabel(mode, status, cameraActive, room)}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {status === "connected" ? "Direct, private video between devices." : online ? "We look for your camera again if Wi-Fi drops." : "Keeps checking while the app is open."}
                  </p>
                </div>
              </div>
            </section>

            <section className="border-t border-border/80 pt-5">
              <SectionLabel index="C" title="WHAT STAYS ON YOUR PHONE" />
              <div className="mt-3 space-y-3">
                <FeatureLine icon={BatteryCharging} text="Battery & live device status" />
                <FeatureLine icon={RefreshCw} text="Automatic reconnect on signal loss" />
                <FeatureLine icon={ShieldCheck} text="Live video is not recorded" />
              </div>
            </section>

            {mode === "viewer" && remoteBattery && (
              <section className="border-t border-border/80 pt-5" aria-live="polite">
                <SectionLabel index="D" title="CAMERA DEVICE" />
                <div className="mt-3 flex items-center gap-3">
                  {remoteBattery.charging ? <BatteryCharging className="size-4 text-[var(--signal)]" /> : <Activity className="size-4 text-muted-foreground" />}
                  <span className="text-sm">{remoteBattery.level}% battery{remoteBattery.charging ? " · charging" : ""}</span>
                </div>
              </section>
            )}

            <div className="mt-auto hidden border-t border-border/70 pt-4 lg:block">
              <p className="mono-data flex items-center gap-1.5 text-[10px] uppercase text-muted-foreground"><ShieldCheck className="size-3 text-[var(--signal)]" /> Private by design</p>
              <p className="mt-2 text-[10px] leading-5 text-muted-foreground">A little peace of mind, wherever you are.</p>
            </div>
          </aside>
        </div>

        <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border/80 pt-4 lg:mt-10">
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground"><ShieldCheck className="size-3.5 text-[var(--signal)]" /><span>Video travels directly between your devices.</span></div>
          <span className="mono-data text-[9px] uppercase text-muted-foreground/70">KEEPWATCH · WATCH WITH CARE</span>
        </footer>
      </div>
    </main>
  );
}

function BrandMark() {
  return <span className="relative flex size-8 items-center justify-center rounded-[3px] bg-primary" aria-hidden="true">
    <Camera className="size-[17px] text-primary-foreground" strokeWidth={2.3} />
    <span className="absolute right-[5px] top-[5px] size-1.5 rounded-full bg-[var(--coral)]" />
  </span>;
}

function LiveBadge({ label, active = true }: { label: string; active?: boolean }) {
  return <Badge variant="outline" className={`h-7 rounded-sm border-border px-2.5 text-[10px] font-medium ${active ? "text-[var(--signal)]" : "text-muted-foreground"}`}>
    <span className={`mr-1.5 size-1.5 rounded-full ${active ? "animate-pulse bg-[var(--signal)]" : "bg-muted-foreground/50"}`} />{label}
  </Badge>;
}

function OnAirChip() {
  return <span className="flex items-center gap-1.5 rounded-sm bg-[var(--coral)] px-2 py-1 text-[10px] font-semibold text-[var(--primary-foreground)]"><CircleDot className="size-3" /> ON AIR</span>;
}

function SectionLabel({ index, title }: { index: string; title: string }) {
  return <h2 className="mono-data flex items-center gap-2 text-[10px] font-medium text-muted-foreground"><span className="text-primary">{index}</span><span className="h-px w-4 bg-border" />{title}</h2>;
}

function DetailRow({ icon: Icon, label, value, detail, level, valueTone }: {
  icon: typeof Activity;
  label: string;
  value: string;
  detail: string;
  level?: number;
  valueTone?: "signal" | "coral";
}) {
  return <div className="flex min-h-[68px] items-center gap-3 py-2.5">
    <div className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-secondary text-muted-foreground"><Icon className={`size-4 ${valueTone === "signal" ? "text-[var(--signal)]" : valueTone === "coral" ? "text-[var(--coral)]" : ""}`} strokeWidth={1.8} /></div>
    <div className="min-w-0 flex-1">
      <p className="text-xs font-medium text-foreground">{label}</p>
      <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{detail}</p>
      {level !== undefined && <div className="mt-1.5 h-1 w-full max-w-28 overflow-hidden rounded-full bg-secondary"><div className={`h-full rounded-full transition-[width] ${level <= 20 ? "bg-[var(--coral)]" : "bg-[var(--signal)]"}`} style={{ width: `${level}%` }} /></div>}
    </div>
    <span className={`mono-data shrink-0 text-xs ${valueTone === "signal" ? "text-[var(--signal)]" : valueTone === "coral" ? "text-[var(--coral)]" : "text-foreground/85"}`}>{value}</span>
  </div>;
}

function FeatureLine({ icon: Icon, text }: { icon: typeof Activity; text: string }) {
  return <div className="flex items-center gap-2.5 text-xs text-muted-foreground"><Icon className="size-3.5 shrink-0 text-[var(--cyan)]" strokeWidth={1.8} /><span>{text}</span></div>;
}

function connectionLabel(mode: AppMode, status: ConnectionStatus, cameraActive: boolean, room: string | null) {
  if (!navigator.onLine) return "Waiting for internet";
  if (mode === "camera" && !cameraActive) return "Camera in standby";
  if (mode === "camera" && status === "connected") return "Viewer connected";
  if (mode === "camera") return "Waiting for viewer";
  if (!room) return "Waiting for camera link";
  if (status === "connected") return "Live feed connected";
  if (status === "retrying") return "Reconnecting automatically";
  return "Connecting to camera";
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${hours > 0 ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}