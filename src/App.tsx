import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";

type AuthMode = "signin" | "signup";

type ConversationRow = {
  id: number;
  name: string;
  description: string;
  created_at: string;
};

type MessageRow = {
  id: number;
  conversation_id: number;
  sender_id: string;
  content: string;
  created_at: string;
  profiles: Array<{
    full_name: string | null;
  }> | null;
};

type ConversationCard = {
  id: number;
  name: string;
  role: string;
  avatar: string;
  status: "online" | "away" | "offline";
  preview: string;
  latestAt: string;
};

type ChatMessage = {
  id: number;
  sender: "me" | "other";
  senderName: string;
  content: string;
  timestamp: string;
};

type InsertedMessagePayload = {
  id: number | string;
  conversation_id: number | string;
  sender_id: string;
  content: string;
  created_at: string;
};

type CallRequestRow = {
  id: number;
  conversation_id: number;
  requester_id: string;
  accepted_by: string | null;
  status: "pending" | "accepted" | "rejected" | "ended" | "cancelled";
  created_at: string;
  updated_at: string;
};

type ActiveCall = {
  id: number;
  conversationId: number;
  requesterId: string;
  acceptedBy: string | null;
  status: CallRequestRow["status"];
};

type SignalPayload = {
  callId: number;
  from: string;
  to?: string;
  conversationId: number;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

type IceServerFunctionResponse = {
  iceServers?: unknown;
  ttlSeconds?: unknown;
};

const pendingInviteStorageKey = "pendingInviteToken";

const statusCycle: Array<ConversationCard["status"]> = [
  "online",
  "away",
  "offline"
];

const asInitials = (name: string) =>
  name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

const formatClock = (isoDate: string) =>
  new Date(isoDate).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });

const defaultIceServers: RTCIceServer[] = [
  {
    urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]
  }
];

const normalizeIceServer = (entry: unknown): RTCIceServer | null => {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }
  const value = entry as Record<string, unknown>;
  const urls = value.urls ?? value.url;
  if (
    !(
      typeof urls === "string" ||
      (Array.isArray(urls) && urls.every((item) => typeof item === "string"))
    )
  ) {
    return null;
  }

  const server: RTCIceServer = {
    urls: urls as string | string[]
  };
  if (typeof value.username === "string") {
    server.username = value.username;
  }
  if (typeof value.credential === "string") {
    server.credential = value.credential;
  }
  return server;
};

const sanitizeIceServers = (value: unknown): RTCIceServer[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeIceServer(entry))
    .filter((entry): entry is RTCIceServer => entry !== null);
};

const hasTurnServer = (servers: RTCIceServer[]) =>
  servers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => /^turns?:/i.test(String(url)));
  });

const parseIceServers = (): RTCIceServer[] => {
  const raw = import.meta.env.VITE_ICE_SERVERS_JSON as string | undefined;
  if (!raw?.trim()) {
    return defaultIceServers;
  }

  try {
    const parsed = JSON.parse(raw);
    const valid = sanitizeIceServers(parsed);
    return valid.length > 0 ? valid : defaultIceServers;
  } catch {
    return defaultIceServers;
  }
};

const ICE_SERVERS = parseIceServers();
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

function App() {
  const [authMode, setAuthMode] = useState<AuthMode>("signin");
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [fullName, setFullName] = useState("");
  const [teamName, setTeamName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [conversations, setConversations] = useState<ConversationCard[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<number | null>(
    null
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageDraft, setMessageDraft] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [composerBusy, setComposerBusy] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [realtimeStatus, setRealtimeStatus] = useState<
    "idle" | "connecting" | "subscribed" | "error"
  >("idle");
  const [unreadByConversation, setUnreadByConversation] = useState<
    Record<number, number>
  >({});
  const [inviteFeedback, setInviteFeedback] = useState<string | null>(null);
  const [pendingInviteToken, setPendingInviteToken] = useState<string | null>(() => {
    const urlToken = new URLSearchParams(window.location.search).get("invite");
    const storedToken = window.localStorage.getItem(pendingInviteStorageKey);
    return urlToken || storedToken || null;
  });
  const [joiningInvite, setJoiningInvite] = useState(false);
  const [callStatus, setCallStatus] = useState<
    "idle" | "requesting" | "ringing" | "connecting" | "in-call" | "error"
  >("idle");
  const [callError, setCallError] = useState<string | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [incomingCall, setIncomingCall] = useState<ActiveCall | null>(null);
  const [pendingOutgoingCall, setPendingOutgoingCall] = useState<ActiveCall | null>(
    null
  );
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [iceConfigMode, setIceConfigMode] = useState<"env" | "dynamic">("env");
  const [currentIceServers, setCurrentIceServers] = useState<RTCIceServer[]>(
    ICE_SERVERS
  );

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const callSignalChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(
    null
  );
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const activeCallRef = useRef<ActiveCall | null>(null);
  const incomingCallRef = useRef<ActiveCall | null>(null);
  const pendingOutgoingCallRef = useRef<ActiveCall | null>(null);
  const pendingRemoteCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const handshakeStartedForCallRef = useRef<number | null>(null);
  const dynamicIceCacheRef = useRef<{ servers: RTCIceServer[]; expiresAt: number } | null>(
    null
  );

  const authed = Boolean(currentUser);
  const activeConversation = useMemo(
    () => conversations.find((item) => item.id === activeConversationId) ?? null,
    [activeConversationId, conversations]
  );
  const turnReady = useMemo(
    () => hasTurnServer(currentIceServers),
    [currentIceServers]
  );

  useEffect(() => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  useEffect(() => {
    activeCallRef.current = activeCall;
  }, [activeCall]);

  useEffect(() => {
    incomingCallRef.current = incomingCall;
  }, [incomingCall]);

  useEffect(() => {
    pendingOutgoingCallRef.current = pendingOutgoingCall;
  }, [pendingOutgoingCall]);

  const applyConversationPreview = useCallback(
    (conversationId: number, content: string, createdAt: string) => {
      setConversations((current) =>
        current
          .map((conversation) =>
            conversation.id === conversationId
              ? { ...conversation, preview: content, latestAt: createdAt }
              : conversation
          )
          .sort(
            (a, b) =>
              new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime()
          )
      );
    },
    []
  );

  const clearInviteQueryParam = useCallback(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("invite")) {
      return;
    }
    url.searchParams.delete("invite");
    const search = url.searchParams.toString();
    const nextUrl = `${url.pathname}${search ? `?${search}` : ""}${url.hash ?? ""}`;
    window.history.replaceState({}, "", nextUrl);
  }, []);

  const normalizeCall = useCallback((row: Partial<CallRequestRow>): ActiveCall | null => {
    const id = Number(row.id);
    const conversationId = Number(row.conversation_id);
    if (!Number.isFinite(id) || !Number.isFinite(conversationId) || !row.requester_id) {
      return null;
    }
    return {
      id,
      conversationId,
      requesterId: row.requester_id,
      acceptedBy: row.accepted_by ?? null,
      status: (row.status as CallRequestRow["status"]) ?? "pending"
    };
  }, []);

  const resetCallMedia = useCallback(() => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.ontrack = null;
      peerConnectionRef.current.onicecandidate = null;
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    pendingRemoteCandidatesRef.current = [];
    handshakeStartedForCallRef.current = null;
    setLocalStream((current) => {
      current?.getTracks().forEach((track) => track.stop());
      return null;
    });
    setRemoteStream((current) => {
      current?.getTracks().forEach((track) => track.stop());
      return null;
    });
    setIsMicMuted(false);
  }, []);

  const assertMediaContext = useCallback(() => {
    if (!window.isSecureContext) {
      throw new Error(
        "Calls need secure context. Open this app on trusted HTTPS (or localhost)."
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser/device does not allow camera or microphone access.");
    }
  }, []);

  const ensureLocalStream = useCallback(async () => {
    assertMediaContext();
    if (localStream) {
      return localStream;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true
    });
    setLocalStream(stream);
    return stream;
  }, [assertMediaContext, localStream]);

  const sendCallSignal = useCallback(
    async (event: string, payload: SignalPayload) => {
      const channel = callSignalChannelRef.current;
      if (!channel) {
        return;
      }
      await channel.send({
        type: "broadcast",
        event,
        payload
      });
    },
    []
  );

  const resolveIceServers = useCallback(async (): Promise<RTCIceServer[]> => {
    const cached = dynamicIceCacheRef.current;
    const now = Date.now();
    if (cached && cached.expiresAt > now + 15_000) {
      return cached.servers;
    }

    try {
      const {
        data: { session }
      } = await supabase.auth.getSession();
      const bearerToken = session?.access_token ?? SUPABASE_ANON_KEY;
      const response = await fetch(`${SUPABASE_URL}/functions/v1/twilio-ice-servers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${bearerToken}`
        },
        body: "{}"
      });

      if (!response.ok) {
        throw new Error(`TURN endpoint request failed (${response.status}).`);
      }
      const data = (await response.json()) as IceServerFunctionResponse;

      const payload = (data ?? {}) as IceServerFunctionResponse;
      const parsedServers = sanitizeIceServers(payload.iceServers);
      if (parsedServers.length === 0) {
        throw new Error("No ICE servers returned by TURN endpoint.");
      }

      const ttlCandidate = Number(payload.ttlSeconds);
      const ttlSeconds =
        Number.isFinite(ttlCandidate) && ttlCandidate > 0
          ? Math.floor(ttlCandidate)
          : 600;
      const refreshSeconds = Math.max(30, ttlSeconds - 60);

      dynamicIceCacheRef.current = {
        servers: parsedServers,
        expiresAt: now + refreshSeconds * 1000
      };
      setCurrentIceServers(parsedServers);
      setIceConfigMode("dynamic");
      return parsedServers;
    } catch {
      setCurrentIceServers(ICE_SERVERS);
      setIceConfigMode("env");
      return ICE_SERVERS;
    }
  }, []);

  const flushPendingRemoteCandidates = useCallback(async () => {
    const peer = peerConnectionRef.current;
    if (!peer || !peer.remoteDescription) {
      return;
    }
    const queued = pendingRemoteCandidatesRef.current;
    if (queued.length === 0) {
      return;
    }
    pendingRemoteCandidatesRef.current = [];
    for (const candidate of queued) {
      try {
        await peer.addIceCandidate(candidate);
      } catch {
        // Ignore invalid/late candidates while connection stabilizes.
      }
    }
  }, []);

  const createPeerConnection = useCallback(
    (
      call: ActiveCall,
      stream: MediaStream,
      myUserId: string,
      iceServers: RTCIceServer[]
    ) => {
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
      }

      const peer = new RTCPeerConnection({
        iceServers
      });

      stream.getTracks().forEach((track) => {
        peer.addTrack(track, stream);
      });

      peer.ontrack = (event) => {
        const streamFromPeer = event.streams[0];
        if (streamFromPeer) {
          setRemoteStream(streamFromPeer);
        }
      };

      peer.onicecandidate = (event) => {
        const candidate = event.candidate;
        if (!candidate) return;
        const targetId =
          myUserId === call.requesterId ? call.acceptedBy : call.requesterId;
        if (!targetId) return;

        void sendCallSignal("webrtc-ice", {
          callId: call.id,
          conversationId: call.conversationId,
          from: myUserId,
          to: targetId,
          candidate: candidate.toJSON()
        });
      };

      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "connected") {
          setCallStatus("in-call");
          setCallError(null);
          return;
        }
        if (peer.connectionState === "failed") {
          setCallStatus("error");
          setCallError("Call failed. Please try again.");
        }
      };

      peer.oniceconnectionstatechange = () => {
        if (peer.iceConnectionState === "failed") {
          setCallStatus("error");
          setCallError(
            "Could not establish media route. Add TURN server for restricted networks."
          );
        }
      };

      peerConnectionRef.current = peer;
      return peer;
    },
    [sendCallSignal]
  );

  const startCallerHandshake = useCallback(
    async (call: ActiveCall, callerId: string) => {
      if (!call.acceptedBy) {
        return;
      }
      if (
        handshakeStartedForCallRef.current === call.id &&
        peerConnectionRef.current
      ) {
        return;
      }
      handshakeStartedForCallRef.current = call.id;
      try {
        setCallStatus("connecting");
        const stream = await ensureLocalStream();
        const iceServers = await resolveIceServers();
        const peer = createPeerConnection(call, stream, callerId, iceServers);
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await sendCallSignal("webrtc-offer", {
          callId: call.id,
          conversationId: call.conversationId,
          from: callerId,
          to: call.acceptedBy,
          sdp: offer
        });
      } catch (error) {
        handshakeStartedForCallRef.current = null;
        setCallStatus("error");
        setCallError(
          error instanceof Error
            ? error.message
            : "Could not start camera/mic for the call."
        );
      }
    },
    [createPeerConnection, ensureLocalStream, resolveIceServers, sendCallSignal]
  );

  const loadConversations = useCallback(async () => {
    const { data: conversationRows, error: conversationError } = await supabase
      .from("conversations")
      .select("id, name, description, created_at")
      .order("created_at", { ascending: true });

    if (conversationError) {
      setChatError(conversationError.message);
      return;
    }

    const rows = (conversationRows ?? []) as ConversationRow[];
    if (rows.length === 0) {
      setConversations([]);
      setActiveConversationId(null);
      return;
    }

    const ids = rows.map((row) => row.id);
    const { data: latestRows, error: latestError } = await supabase
      .from("messages")
      .select("conversation_id, content, created_at")
      .in("conversation_id", ids)
      .order("created_at", { ascending: false });

    if (latestError) {
      setChatError(latestError.message);
      return;
    }

    const latestByConversation = new Map<
      number,
      { content: string; created_at: string }
    >();

    for (const row of latestRows ?? []) {
      const conversationId = row.conversation_id as number;
      if (!latestByConversation.has(conversationId)) {
        latestByConversation.set(conversationId, {
          content: row.content as string,
          created_at: row.created_at as string
        });
      }
    }

    const cards = rows
      .map((row, index) => {
        const latest = latestByConversation.get(row.id);
        return {
          id: row.id,
          name: row.name,
          role: row.description || "Open conversation",
          avatar: asInitials(row.name),
          status: statusCycle[index % statusCycle.length],
          preview: latest?.content ?? "No messages yet",
          latestAt: latest?.created_at ?? row.created_at
        } satisfies ConversationCard;
      })
      .sort(
        (a, b) => new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime()
      );

    setConversations(cards);
    setActiveConversationId((current) => {
      if (current && cards.some((item) => item.id === current)) {
        return current;
      }
      return cards[0].id;
    });
  }, []);

  const loadMessages = useCallback(
    async (conversationId: number, userId: string) => {
      const { data, error } = await supabase
        .from("messages")
        .select(
          "id, conversation_id, sender_id, content, created_at, profiles:sender_id(full_name)"
        )
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });

      if (error) {
        setChatError(error.message);
        return;
      }

      const mapped = ((data ?? []) as MessageRow[]).map((row) => {
        const displayName = row.profiles?.[0]?.full_name?.trim();
        return {
          id: row.id,
          sender: row.sender_id === userId ? ("me" as const) : ("other" as const),
          senderName: row.sender_id === userId ? "You" : displayName || "Member",
          content: row.content,
          timestamp: formatClock(row.created_at)
        };
      });
      setMessages(mapped);
    },
    []
  );

  const ensureProfile = useCallback(async (user: User) => {
    const metadata = user.user_metadata ?? {};
    const fallbackName = user.email?.split("@")[0] ?? "User";

    const { error } = await supabase.from("profiles").upsert(
      {
        id: user.id,
        full_name: (metadata.full_name as string | undefined) ?? fallbackName,
        team_name: (metadata.team_name as string | undefined) ?? null
      },
      { onConflict: "id" }
    );

    if (error) {
      setChatError(error.message);
    }
  }, []);

  useEffect(() => {
    let alive = true;

    const bootstrap = async () => {
      const { data, error } = await supabase.auth.getSession();
      if (!alive) return;
      if (error) {
        setAuthError(error.message);
      }
      if (data.session?.access_token) {
        await supabase.realtime.setAuth(data.session.access_token);
      }
      setCurrentUser(data.session?.user ?? null);
      setLoadingSession(false);
    };

    void bootstrap();

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (!alive) return;
      if (session?.access_token) {
        await supabase.realtime.setAuth(session.access_token);
      }
      setCurrentUser(session?.user ?? null);
    });

    return () => {
      alive = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!pendingInviteToken) {
      return;
    }
    window.localStorage.setItem(pendingInviteStorageKey, pendingInviteToken);
    if (!currentUser) {
      setAuthNotice("Sign in to accept the invite link.");
    }
  }, [currentUser, pendingInviteToken]);

  useEffect(() => {
    if (!currentUser) {
      dynamicIceCacheRef.current = null;
      setCurrentIceServers(ICE_SERVERS);
      setIceConfigMode("env");
      resetCallMedia();
      setActiveCall(null);
      setIncomingCall(null);
      setPendingOutgoingCall(null);
      setCallStatus("idle");
      setCallError(null);
      setConversations([]);
      setMessages([]);
      setActiveConversationId(null);
      setUnreadByConversation({});
      return;
    }

    let alive = true;

    const hydrate = async () => {
      setChatLoading(true);
      setChatError(null);
      await ensureProfile(currentUser);
      await loadConversations();
      if (!alive) return;
      setChatLoading(false);
    };

    void hydrate();
    return () => {
      alive = false;
    };
  }, [currentUser, ensureProfile, loadConversations, resetCallMedia]);

  useEffect(() => {
    if (!currentUser) {
      return;
    }
    void resolveIceServers();
  }, [currentUser, resolveIceServers]);

  useEffect(() => {
    if (!currentUser || !pendingInviteToken || joiningInvite) {
      return;
    }

    let disposed = false;
    const joinFromInvite = async () => {
      setJoiningInvite(true);
      setInviteFeedback("Joining invited room...");
      const { data, error } = await supabase.rpc("accept_room_invite", {
        p_token: pendingInviteToken
      });

      if (disposed) return;

      if (error) {
        setInviteFeedback(`Invite failed: ${error.message}`);
        window.localStorage.removeItem(pendingInviteStorageKey);
        setPendingInviteToken(null);
        setJoiningInvite(false);
        return;
      }

      const joinedConversationId = Number(data);
      await loadConversations();
      if (Number.isFinite(joinedConversationId)) {
        setActiveConversationId(joinedConversationId);
      }
      window.localStorage.removeItem(pendingInviteStorageKey);
      clearInviteQueryParam();
      setPendingInviteToken(null);
      setInviteFeedback("Invite accepted. You joined the room.");
      setJoiningInvite(false);
    };

    void joinFromInvite();
    return () => {
      disposed = true;
    };
  }, [
    clearInviteQueryParam,
    currentUser,
    joiningInvite,
    loadConversations,
    pendingInviteToken
  ]);

  useEffect(() => {
    if (!currentUser || activeConversationId === null) {
      setMessages([]);
      return;
    }

    setUnreadByConversation((current) => {
      if (!current[activeConversationId]) return current;
      return { ...current, [activeConversationId]: 0 };
    });

    const run = async () => {
      setMessagesLoading(true);
      await loadMessages(activeConversationId, currentUser.id);
      setMessagesLoading(false);
    };

    void run();
  }, [activeConversationId, currentUser, loadMessages]);

  useEffect(() => {
    if (!currentUser) return;

    let isDisposed = false;
    setRealtimeStatus("connecting");

    const { data: authSub } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        if (session?.access_token) {
          await supabase.realtime.setAuth(session.access_token);
        }
      }
    );

    const channel = supabase
      .channel(`chat-realtime-${currentUser.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          const inserted = payload.new as InsertedMessagePayload;
          const insertedId = Number(inserted.id);
          const insertedConversationId = Number(inserted.conversation_id);
          if (!Number.isFinite(insertedConversationId) || !Number.isFinite(insertedId)) {
            return;
          }
          const mine = inserted.sender_id === currentUser.id;

          applyConversationPreview(
            insertedConversationId,
            inserted.content,
            inserted.created_at
          );

          if (!mine) {
            setUnreadByConversation((current) => {
              if (insertedConversationId === activeConversationId) {
                return current;
              }
              const value = current[insertedConversationId] ?? 0;
              return { ...current, [insertedConversationId]: value + 1 };
            });
          }
          if (insertedConversationId === activeConversationId) {
            setMessages((current) => {
              if (current.some((message) => message.id === insertedId)) {
                return current;
              }
              return [
                ...current,
                {
                  id: insertedId,
                  sender: mine ? "me" : "other",
                  senderName: mine ? "You" : "Member",
                  content: inserted.content,
                  timestamp: formatClock(inserted.created_at)
                }
              ];
            });
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "conversations" },
        () => {
          void loadConversations();
        }
      )
      .subscribe((status) => {
        if (isDisposed) return;
        if (status === "SUBSCRIBED") {
          setRealtimeStatus("subscribed");
          return;
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setRealtimeStatus("error");
          return;
        }
        setRealtimeStatus("connecting");
      });

    return () => {
      isDisposed = true;
      setRealtimeStatus("idle");
      authSub.subscription.unsubscribe();
      void supabase.removeChannel(channel);
    };
  }, [
    activeConversationId,
    applyConversationPreview,
    currentUser,
    loadConversations
  ]);

  useEffect(() => {
    if (!currentUser) return;

    // Fallback sync to avoid manual refresh if websocket gets blocked/disconnected.
    const intervalId = window.setInterval(() => {
      void loadConversations();
      if (activeConversationId !== null) {
        void loadMessages(activeConversationId, currentUser.id);
      }
    }, 4000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeConversationId, currentUser, loadConversations, loadMessages]);

  useEffect(() => {
    if (!currentUser) return;

    const handleCallChange = (raw: Partial<CallRequestRow>) => {
      const call = normalizeCall(raw);
      if (!call) return;

      if (call.status === "pending") {
        if (call.requesterId === currentUser.id) {
          setPendingOutgoingCall(call);
          setCallStatus("requesting");
        } else {
          setIncomingCall(call);
          setCallStatus((current) => (current === "idle" ? "ringing" : current));
        }
        return;
      }

      if (call.status === "accepted") {
        setActiveConversationId(call.conversationId);
        if (call.requesterId === currentUser.id && call.acceptedBy) {
          setPendingOutgoingCall(null);
          setCallError(null);
          setActiveCall(call);
          if (!peerConnectionRef.current) {
            void startCallerHandshake(call, currentUser.id);
          }
          return;
        }
        if (call.acceptedBy === currentUser.id) {
          setIncomingCall(null);
          setCallError(null);
          setActiveCall(call);
          setCallStatus("connecting");
        }
        return;
      }

      if (
        call.status === "ended" ||
        call.status === "cancelled" ||
        call.status === "rejected"
      ) {
        const isRelated =
          activeCallRef.current?.id === call.id ||
          incomingCallRef.current?.id === call.id ||
          pendingOutgoingCallRef.current?.id === call.id;
        if (!isRelated) return;

        resetCallMedia();
        setActiveCall(null);
        setIncomingCall(null);
        setPendingOutgoingCall(null);
        if (call.status === "rejected" && call.requesterId === currentUser.id) {
          setCallError("Call was declined.");
        }
        setCallStatus("idle");
      }
    };

    const channel = supabase
      .channel(`call-requests-${currentUser.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "call_requests" },
        (payload) => handleCallChange(payload.new as Partial<CallRequestRow>)
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "call_requests" },
        (payload) => handleCallChange(payload.new as Partial<CallRequestRow>)
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [currentUser, normalizeCall, resetCallMedia, startCallerHandshake]);

  useEffect(() => {
    if (!currentUser) return;

    const channel = supabase
      .channel("call-signal-global")
      .on("broadcast", { event: "call-accepted" }, async ({ payload }) => {
        const signal = payload as SignalPayload;
        if (signal.to && signal.to !== currentUser.id) return;

        const pending = pendingOutgoingCallRef.current;
        if (!pending || pending.id !== signal.callId) return;

        const accepted: ActiveCall = {
          ...pending,
          acceptedBy: signal.from,
          status: "accepted"
        };
        setPendingOutgoingCall(null);
        setActiveCall(accepted);
        setCallStatus("connecting");
        setActiveConversationId(accepted.conversationId);
        await startCallerHandshake(accepted, currentUser.id);
      })
      .on("broadcast", { event: "webrtc-offer" }, async ({ payload }) => {
        const signal = payload as SignalPayload;
        if (signal.to && signal.to !== currentUser.id) return;
        if (!signal.sdp) return;

        let call = activeCallRef.current;
        if (!call || call.id !== signal.callId) {
          const incoming = incomingCallRef.current;
          if (!incoming || incoming.id !== signal.callId) return;
          call = {
            ...incoming,
            status: "accepted",
            acceptedBy: currentUser.id
          };
          setIncomingCall(null);
          setActiveCall(call);
        }

        try {
          setCallStatus("connecting");
          const stream = await ensureLocalStream();
          const iceServers = await resolveIceServers();
          const peer = createPeerConnection(
            call,
            stream,
            currentUser.id,
            iceServers
          );
          await peer.setRemoteDescription(signal.sdp);
          await flushPendingRemoteCandidates();
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          await sendCallSignal("webrtc-answer", {
            callId: call.id,
            conversationId: call.conversationId,
            from: currentUser.id,
            to: signal.from,
            sdp: answer
          });
        } catch (error) {
          setCallStatus("error");
          setCallError(
            error instanceof Error ? error.message : "Could not answer the call."
          );
        }
      })
      .on("broadcast", { event: "webrtc-answer" }, async ({ payload }) => {
        const signal = payload as SignalPayload;
        if (signal.to && signal.to !== currentUser.id) return;
        if (!signal.sdp || !peerConnectionRef.current) return;

        await peerConnectionRef.current.setRemoteDescription(signal.sdp);
        await flushPendingRemoteCandidates();
      })
      .on("broadcast", { event: "webrtc-ice" }, async ({ payload }) => {
        const signal = payload as SignalPayload;
        if (signal.to && signal.to !== currentUser.id) return;
        if (!signal.candidate || !peerConnectionRef.current) return;

        try {
          if (peerConnectionRef.current.remoteDescription) {
            await peerConnectionRef.current.addIceCandidate(signal.candidate);
          } else {
            pendingRemoteCandidatesRef.current.push(signal.candidate);
          }
        } catch {
          // Ignore ICE failures for MVP flow.
        }
      })
      .on("broadcast", { event: "call-ended" }, ({ payload }) => {
        const signal = payload as SignalPayload;
        const isRelated =
          activeCallRef.current?.id === signal.callId ||
          incomingCallRef.current?.id === signal.callId ||
          pendingOutgoingCallRef.current?.id === signal.callId;
        if (!isRelated) return;

        resetCallMedia();
        setActiveCall(null);
        setIncomingCall(null);
        setPendingOutgoingCall(null);
        setCallStatus("idle");
      })
      .subscribe();

    callSignalChannelRef.current = channel;

    return () => {
      callSignalChannelRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [
    createPeerConnection,
    currentUser,
    ensureLocalStream,
    flushPendingRemoteCandidates,
    resolveIceServers,
    resetCallMedia,
    sendCallSignal,
    startCallerHandshake
  ]);

  useEffect(() => {
    if (callStatus !== "connecting") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setCallError(
        "Still connecting. This usually means peer networking is blocked; TURN server is required."
      );
    }, 12000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [callStatus]);

  const handleAuthSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (authLoading) return;
    setAuthLoading(true);
    setAuthError(null);
    setAuthNotice(null);

    if (authMode === "signin") {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password
      });

      if (error) {
        setAuthError(error.message);
      }
      setAuthLoading(false);
      return;
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}${window.location.pathname}`,
        data: {
          full_name: fullName,
          team_name: teamName
        }
      }
    });

    if (error) {
      setAuthError(error.message);
      setAuthLoading(false);
      return;
    }

    if (!data.session) {
      setAuthNotice("Account created. Check your email to confirm, then sign in.");
      setAuthMode("signin");
    }

    setAuthLoading(false);
  };

  const createConversation = async () => {
    if (!currentUser || creatingConversation) return;

    const name = window.prompt("Conversation name");
    if (!name || !name.trim()) return;
    const description =
      window.prompt("Short description", "Team discussion") || "Team discussion";

    setCreatingConversation(true);
    setChatError(null);
    const { data, error } = await supabase.rpc("create_conversation_room", {
      p_name: name.trim(),
      p_description: description.trim()
    });

    if (error) {
      setChatError(error.message);
      setCreatingConversation(false);
      return;
    }

    await loadConversations();
    const createdConversationId = Number(data);
    if (Number.isFinite(createdConversationId)) {
      setActiveConversationId(createdConversationId);
    }
    setCreatingConversation(false);
  };

  const createInviteLink = async () => {
    if (!currentUser || activeConversationId === null) {
      return;
    }
    setInviteFeedback(null);

    const { data, error } = await supabase.rpc("create_room_invite", {
      p_conversation_id: activeConversationId,
      p_max_uses: 1,
      p_expires_in_minutes: 60 * 24 * 7
    });

    if (error) {
      setInviteFeedback(`Could not create invite: ${error.message}`);
      return;
    }

    const token = String(data ?? "");
    if (!token) {
      setInviteFeedback("Invite token generation failed.");
      return;
    }

    const inviteUrl = `${window.location.origin}${window.location.pathname}?invite=${token}`;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setInviteFeedback("Invite link copied. Share it with the person you want to invite.");
    } catch {
      window.prompt("Copy this invite link", inviteUrl);
      setInviteFeedback("Invite link generated.");
    }
  };

  const requestCall = async () => {
    if (!currentUser || activeConversationId === null) return;
    if (callStatus === "connecting" || callStatus === "in-call" || callStatus === "requesting") {
      return;
    }

    try {
      assertMediaContext();
    } catch (error) {
      setCallStatus("error");
      setCallError(
        error instanceof Error ? error.message : "This device cannot start calls here."
      );
      return;
    }

    setCallError(null);
    const { data, error } = await supabase
      .from("call_requests")
      .insert({
        conversation_id: activeConversationId,
        requester_id: currentUser.id,
        status: "pending"
      })
      .select(
        "id, conversation_id, requester_id, accepted_by, status, created_at, updated_at"
      )
      .single();

    if (error) {
      setCallStatus("error");
      setCallError(error.message);
      return;
    }

    const pending = normalizeCall(data as Partial<CallRequestRow>);
    if (!pending) {
      setCallStatus("error");
      setCallError("Failed to create call request.");
      return;
    }

    setPendingOutgoingCall(pending);
    setCallStatus("requesting");
  };

  const acceptIncomingCall = async () => {
    if (!incomingCall || !currentUser) return;

    const { error } = await supabase
      .from("call_requests")
      .update({
        status: "accepted",
        accepted_by: currentUser.id,
        updated_at: new Date().toISOString()
      })
      .eq("id", incomingCall.id);

    if (error) {
      setCallStatus("error");
      setCallError(error.message);
      return;
    }

    const acceptedCall: ActiveCall = {
      ...incomingCall,
      status: "accepted",
      acceptedBy: currentUser.id
    };
    setActiveConversationId(acceptedCall.conversationId);
    setIncomingCall(null);
    setActiveCall(acceptedCall);
    setCallStatus("connecting");
    setCallError(null);

    await sendCallSignal("call-accepted", {
      callId: acceptedCall.id,
      conversationId: acceptedCall.conversationId,
      from: currentUser.id,
      to: acceptedCall.requesterId
    });
  };

  const rejectIncomingCall = async () => {
    if (!incomingCall || !currentUser) return;

    const { error } = await supabase
      .from("call_requests")
      .update({
        status: "rejected",
        accepted_by: currentUser.id,
        updated_at: new Date().toISOString()
      })
      .eq("id", incomingCall.id);

    if (error) {
      setCallStatus("error");
      setCallError(error.message);
      return;
    }

    setIncomingCall(null);
    setCallStatus("idle");
  };

  const endCall = async () => {
    if (!currentUser) return;

    const current = activeCall || pendingOutgoingCall || incomingCall;
    if (!current) return;

    const nextStatus: CallRequestRow["status"] =
      current.status === "pending" && current.requesterId === currentUser.id
        ? "cancelled"
        : "ended";

    const { error } = await supabase
      .from("call_requests")
      .update({
        status: nextStatus,
        updated_at: new Date().toISOString()
      })
      .eq("id", current.id);

    if (error) {
      setCallStatus("error");
      setCallError(error.message);
      return;
    }

    const targetId =
      currentUser.id === current.requesterId ? current.acceptedBy : current.requesterId;

    if (targetId) {
      await sendCallSignal("call-ended", {
        callId: current.id,
        conversationId: current.conversationId,
        from: currentUser.id,
        to: targetId
      });
    }

    resetCallMedia();
    setActiveCall(null);
    setIncomingCall(null);
    setPendingOutgoingCall(null);
    setCallStatus("idle");
  };

  const toggleMic = () => {
    if (!localStream) return;
    const nextMuted = !isMicMuted;
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setIsMicMuted(nextMuted);
  };

  const sendMessage = async () => {
    const trimmed = messageDraft.trim();
    if (!trimmed || !currentUser || activeConversationId === null || composerBusy) {
      return;
    }

    const optimisticId = -Date.now();
    const optimisticIsoTime = new Date().toISOString();

    setMessageDraft("");
    setMessages((current) => [
      ...current,
      {
        id: optimisticId,
        sender: "me",
        senderName: "You",
        content: trimmed,
        timestamp: formatClock(optimisticIsoTime)
      }
    ]);
    applyConversationPreview(activeConversationId, trimmed, optimisticIsoTime);

    setComposerBusy(true);
    setChatError(null);

    const { data, error } = await supabase
      .from("messages")
      .insert({
        conversation_id: activeConversationId,
        sender_id: currentUser.id,
        content: trimmed
      })
      .select("id, created_at, content, conversation_id")
      .single();

    if (error) {
      setChatError(error.message);
      setMessages((current) =>
        current.filter((message) => message.id !== optimisticId)
      );
      setComposerBusy(false);
      return;
    }

    const insertedId = Number(data.id);
    const createdAt = String(data.created_at);
    setMessages((current) =>
      current.map((message) =>
        message.id === optimisticId
          ? {
              ...message,
              id: Number.isFinite(insertedId) ? insertedId : optimisticId,
              timestamp: formatClock(createdAt)
            }
          : message
      )
    );
    applyConversationPreview(activeConversationId, trimmed, createdAt);
    setComposerBusy(false);
  };

  const logout = async () => {
    await endCall();
    await supabase.auth.signOut();
    setAuthMode("signin");
    setPassword("");
  };

  const callForActiveConversation =
    (incomingCall && incomingCall.conversationId === activeConversationId && incomingCall) ||
    (pendingOutgoingCall &&
      pendingOutgoingCall.conversationId === activeConversationId &&
      pendingOutgoingCall) ||
    (activeCall && activeCall.conversationId === activeConversationId && activeCall) ||
    null;

  if (!authed) {
    return (
      <main className="auth-layout">
        <div className="ambient ambient-left" />
        <div className="ambient ambient-right" />

        <section className="auth-story">
          <p className="chip">LUMEN CHAT</p>
          <h1>Conversation UI with runway-level visual polish.</h1>
          <p className="lead">
            Powered by Supabase Auth + Database. Sign in to your workspace to load
            live conversations and persisted messages.
          </p>

          <div className="story-grid">
            <article className="story-card">
              <h3>Real authentication</h3>
              <p>Email/password sign in and persistent sessions.</p>
            </article>
            <article className="story-card">
              <h3>Persistent chat data</h3>
              <p>Conversations and messages are stored in Supabase tables.</p>
            </article>
            <article className="story-card">
              <h3>Realtime updates</h3>
              <p>New messages sync across clients using live database events.</p>
            </article>
          </div>
        </section>

        <section className="auth-shell glass-card">
          <div className="tab-switch">
            <button
              className={authMode === "signin" ? "active" : ""}
              onClick={() => setAuthMode("signin")}
              type="button"
            >
              Sign In
            </button>
            <button
              className={authMode === "signup" ? "active" : ""}
              onClick={() => setAuthMode("signup")}
              type="button"
            >
              Create Account
            </button>
          </div>

          <form className="auth-form" onSubmit={handleAuthSubmit}>
            {authMode === "signup" ? (
              <label>
                Full Name
                <input
                  onChange={(event) => setFullName(event.target.value)}
                  placeholder="Ariana Lee"
                  required
                  type="text"
                  value={fullName}
                />
              </label>
            ) : null}
            <label>
              Work Email
              <input
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@lumen.team"
                required
                type="email"
                value={email}
              />
            </label>
            <label>
              Password
              <input
                minLength={8}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Minimum 8 characters"
                required
                type="password"
                value={password}
              />
            </label>
            {authMode === "signup" ? (
              <label>
                Team Name
                <input
                  onChange={(event) => setTeamName(event.target.value)}
                  placeholder="Lumen Studio"
                  required
                  type="text"
                  value={teamName}
                />
              </label>
            ) : null}

            <button className="cta" disabled={authLoading || loadingSession} type="submit">
              {authLoading
                ? "Please wait..."
                : authMode === "signin"
                  ? "Enter Workspace"
                  : "Create Workspace"}
            </button>
          </form>

          {authError ? <p className="feedback error">{authError}</p> : null}
          {authNotice ? <p className="feedback success">{authNotice}</p> : null}

          <div className="auth-meta">
            <span>Session status</span>
            <div>{loadingSession ? "Checking..." : "Ready"}</div>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="chat-layout">
      <div className="grid-overlay" />

      <aside className="sidebar glass-card">
        <header className="sidebar-header">
          <div>
            <p className="chip small">LUMEN</p>
            <h2>Messages</h2>
          </div>
          <button disabled={creatingConversation} onClick={createConversation} type="button">
            {creatingConversation ? "..." : "New"}
          </button>
        </header>

        <label className="search-input">
          <span>Search</span>
          <input placeholder="Connected to backend storage" readOnly type="text" />
        </label>

        <div className="conversation-list">
          {conversations.map((conversation) => (
            <button
              className={`conversation-item ${
                conversation.id === activeConversationId ? "active" : ""
              }`}
              key={conversation.id}
              onClick={() => setActiveConversationId(conversation.id)}
              type="button"
            >
              <div className="avatar">{conversation.avatar}</div>
              <div className="conversation-copy">
                <div className="row">
                  <strong>{conversation.name}</strong>
                  {(unreadByConversation[conversation.id] ?? 0) > 0 ? (
                    <span>{unreadByConversation[conversation.id] ?? 0}</span>
                  ) : null}
                </div>
                <p>{conversation.preview}</p>
                <small>
                  <i className={`status-dot ${conversation.status}`} />
                  {conversation.role}
                </small>
              </div>
            </button>
          ))}

          {!chatLoading && conversations.length === 0 ? (
            <article className="empty-note">
              <p>No conversations yet.</p>
              <button onClick={createConversation} type="button">
                Create your first room
              </button>
            </article>
          ) : null}
        </div>
      </aside>

      <section className="chat-surface glass-card">
        <header className="thread-header">
          <div>
            <h3>{activeConversation?.name ?? "No conversation selected"}</h3>
            <p>{activeConversation?.role ?? "Create a room to begin chatting"}</p>
          </div>
          <div className="thread-actions">
            <button onClick={loadConversations} type="button">
              Refresh
            </button>
            <button
              disabled={activeConversationId === null}
              onClick={createInviteLink}
              type="button"
            >
              Invite
            </button>
            <button
              disabled={activeConversationId === null || callStatus === "connecting"}
              onClick={callForActiveConversation ? endCall : requestCall}
              type="button"
            >
              {callForActiveConversation ? "End Call" : "Request Call"}
            </button>
            <button onClick={createConversation} type="button">
              New Room
            </button>
            <button onClick={logout} type="button">
              Log out
            </button>
          </div>
        </header>

        {chatError ? <p className="feedback error">{chatError}</p> : null}
        {callError ? <p className="feedback error">{callError}</p> : null}
        {inviteFeedback ? <p className="feedback success">{inviteFeedback}</p> : null}

        {incomingCall && incomingCall.conversationId === activeConversationId ? (
          <section className="call-banner">
            <p>Incoming call request for this room</p>
            <div>
              <button onClick={acceptIncomingCall} type="button">
                Pick up
              </button>
              <button onClick={rejectIncomingCall} type="button">
                Decline
              </button>
            </div>
          </section>
        ) : null}

        {pendingOutgoingCall &&
        pendingOutgoingCall.conversationId === activeConversationId ? (
          <section className="call-banner">
            <p>Calling... waiting for someone to pick up</p>
            <div>
              <button onClick={endCall} type="button">
                Cancel
              </button>
            </div>
          </section>
        ) : null}

        {activeCall && activeCall.conversationId === activeConversationId ? (
          <section className="call-stage">
            <div className="call-head">
              <strong>
                {callStatus === "in-call" ? "Call connected" : "Connecting call..."}
              </strong>
              <div>
                <button onClick={toggleMic} type="button">
                  {isMicMuted ? "Unmute" : "Mute"}
                </button>
                <button onClick={endCall} type="button">
                  End
                </button>
              </div>
            </div>
            <div className="call-videos">
              <video
                autoPlay
                className="video-card"
                muted
                playsInline
                ref={localVideoRef}
              />
              <video autoPlay className="video-card" playsInline ref={remoteVideoRef} />
            </div>
          </section>
        ) : null}

        <div className="message-stream">
          {messagesLoading ? <p className="state-note">Loading messages...</p> : null}
          {!messagesLoading && messages.length === 0 ? (
            <p className="state-note">No messages yet. Send the first one.</p>
          ) : null}
          {messages.map((message) => (
            <article
              className={`message ${message.sender === "me" ? "mine" : "theirs"}`}
              key={message.id}
            >
              <span className="message-sender">{message.senderName}</span>
              <p>{message.content}</p>
              <time>{message.timestamp}</time>
            </article>
          ))}
        </div>

        <footer className="composer">
          <input
            disabled={activeConversationId === null}
            onChange={(event) => setMessageDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void sendMessage();
              }
            }}
            placeholder="Write a message..."
            type="text"
            value={messageDraft}
          />
          <button
            disabled={activeConversationId === null || composerBusy}
            onClick={sendMessage}
            type="button"
          >
            {composerBusy ? "Sending..." : "Send"}
          </button>
        </footer>
      </section>

      <aside className="inspector glass-card">
        <div className="profile-card">
          <div className="avatar large">
            {asInitials(currentUser?.user_metadata?.full_name || currentUser?.email || "ME")}
          </div>
          <h4>{currentUser?.user_metadata?.full_name || currentUser?.email}</h4>
          <p>{currentUser?.email}</p>
        </div>

        <section className="stack">
          <h5>Backend status</h5>
          <ul>
            <li>Auth session: active</li>
            <li>Realtime: {realtimeStatus}</li>
            <li>ICE config: {iceConfigMode === "dynamic" ? "twilio-turn" : "env"}</li>
            <li>TURN available: {turnReady ? "yes" : "no"}</li>
            <li>Call state: {callStatus}</li>
            <li>Conversations: {conversations.length}</li>
            <li>Current room messages: {messages.length}</li>
          </ul>
        </section>

        <section className="stack">
          <h5>Workspace</h5>
          <button onClick={loadConversations} type="button">
            Sync from database
          </button>
          <button onClick={createConversation} type="button">
            Create conversation
          </button>
          <button onClick={logout} type="button">
            Sign out
          </button>
        </section>
      </aside>
    </main>
  );
}

export default App;
