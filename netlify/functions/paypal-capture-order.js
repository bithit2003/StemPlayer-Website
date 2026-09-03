async function getAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const env = process.env.PAYPAL_ENV || "sandbox";

  const baseUrl =
    env === "live"
      ? "https://api-m.paypal.com"
      : "https://api-m.sandbox.paypal.com";

  const auth = Buffer.from(
    `${clientId}:${clientSecret}`
  ).toString("base64");

  const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  if (!response.ok) {
    throw new Error("PayPal OAuth failed");
  }

  const data = await response.json();

  return {
    accessToken: data.access_token,
    baseUrl
  };
}

export default async (request) => {
  try {
    const url = new URL(request.url);
    const orderId = url.searchParams.get("order_id");

    if (!orderId) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Missing order_id"
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    const { accessToken, baseUrl } = await getAccessToken();

    const response = await fetch(
      `${baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: "{}"
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return new Response(
        JSON.stringify({
          ok: false,
          paypal_status: response.status,
          error: "PayPal capture failed",
          details: data
        }),
        {
          status: 502,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        order_id: data.id,
        status: data.status,
        capture_id:
          data.purchase_units?.[0]?.payments?.captures?.[0]?.id || null,
        amount:
          data.purchase_units?.[0]?.payments?.captures?.[0]?.amount || null
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  } catch {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Unexpected server error"
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
};