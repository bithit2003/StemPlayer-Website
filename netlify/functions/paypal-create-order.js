async function getPayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const env = process.env.PAYPAL_ENV || "sandbox";

  if (!clientId || !clientSecret) {
    throw new Error("Missing PayPal credentials");
  }

  const baseUrl =
    env === "live"
      ? "https://api-m.paypal.com"
      : "https://api-m.sandbox.paypal.com";

  const basicAuth = Buffer.from(
    `${clientId}:${clientSecret}`
  ).toString("base64");

  const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  if (!response.ok) {
    throw new Error(`PayPal OAuth failed: ${response.status}`);
  }

  const data = await response.json();

  return {
    accessToken: data.access_token,
    baseUrl
  };
}

export default async () => {
  try {
    const { accessToken, baseUrl } = await getPayPalAccessToken();

    const orderResponse = await fetch(
      `${baseUrl}/v2/checkout/orders`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [
            {
              reference_id: "STEMPLAYER_V2_EARLY_BIRD",
              description: "StemPlayer V2 - Early Bird License",
              amount: {
                currency_code: "USD",
                value: "5.00"
              }
            }
          ],
          application_context: {
            brand_name: "StemPlayer",
            landing_page: "NO_PREFERENCE",
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING"
          }
        })
      }
    );

    const orderData = await orderResponse.json();

    if (!orderResponse.ok) {
      return new Response(
        JSON.stringify({
          ok: false,
          paypal_status: orderResponse.status,
          error: "PayPal order creation failed",
          details: orderData
        }),
        {
          status: 502,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    const approvalLink =
      orderData.links?.find(
        link =>
          link.rel === "approve" ||
          link.rel === "payer-action"
      )?.href || null;

    return new Response(
      JSON.stringify({
        ok: true,
        order_id: orderData.id,
        status: orderData.status,
        amount: "5.00",
        currency: "USD",
        product: "StemPlayer V2 Early Bird",
        approval_url: approvalLink
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  } catch (error) {
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