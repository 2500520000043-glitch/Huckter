import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

type TwilioIceServer = {
  url?: string;
  urls?: string | string[];
  username?: string;
  credential?: string;
};

type TwilioTokenResponse = {
  ice_servers?: TwilioIceServer[];
};

const normalizeIceServer = (entry: TwilioIceServer) => {
  const urls = entry.urls ?? entry.url;
  if (
    !(
      typeof urls === "string" ||
      (Array.isArray(urls) && urls.every((item) => typeof item === "string"))
    )
  ) {
    return null;
  }

  return {
    urls,
    username: entry.username ?? undefined,
    credential: entry.credential ?? undefined
  };
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed. Use POST." }),
      { status: 405, headers: corsHeaders }
    );
  }

  try {
    const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
    const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
    const configuredTtl = Number(Deno.env.get("TWILIO_NTS_TTL_SECONDS") ?? "3600");

    if (!accountSid || !authToken) {
      return new Response(
        JSON.stringify({
          error: "Missing Twilio secret. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN."
        }),
        { status: 500, headers: corsHeaders }
      );
    }

    const ttlSeconds =
      Number.isFinite(configuredTtl) && configuredTtl > 0
        ? Math.min(Math.max(Math.floor(configuredTtl), 60), 86400)
        : 3600;

    const body = new URLSearchParams({ Ttl: String(ttlSeconds) });
    const authHeader = `Basic ${btoa(`${accountSid}:${authToken}`)}`;
    const twilioResponse = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Tokens.json`,
      {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body
      }
    );

    if (!twilioResponse.ok) {
      const details = await twilioResponse.text();
      return new Response(
        JSON.stringify({
          error: "Twilio token request failed.",
          details: details.slice(0, 400)
        }),
        { status: 502, headers: corsHeaders }
      );
    }

    const tokenPayload = (await twilioResponse.json()) as TwilioTokenResponse;
    const iceServers = (tokenPayload.ice_servers ?? [])
      .map((entry) => normalizeIceServer(entry))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    if (iceServers.length === 0) {
      return new Response(
        JSON.stringify({ error: "Twilio returned no usable ICE servers." }),
        { status: 502, headers: corsHeaders }
      );
    }

    return new Response(
      JSON.stringify({
        iceServers,
        ttlSeconds
      }),
      { headers: corsHeaders }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({
        error: "Failed to generate ICE servers.",
        details: message
      }),
      { status: 500, headers: corsHeaders }
    );
  }
});

