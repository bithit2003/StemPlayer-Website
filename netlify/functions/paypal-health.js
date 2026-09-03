export default async () => {
  try {
    const clientId = process.env.PAYPAL_CLIENT_ID;
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
    const env = process.env.PAYPAL_ENV || "sandbox";

    if (!clientId || !clientSecret) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Missing PayPal environment variables"
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    const baseUrl =
      env === "live"
        ? "https://api-m.paypal.com"
        : "https://api-m.sandbox.paypal.com";

    const basicAuth = Buffer.from(
      `${clientId}:${clientSecret}`
    ).toString("base64");

    const paypalResponse = await fetch(
      `${baseUrl}/v1/oauth2/token`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: "grant_type=client_credentials"
      }
    );

    if (!paypalResponse.ok) {
      return new Response(
        JSON.stringify({
          ok: false,
          paypal_status: paypalResponse.status,
          error: "PayPal authentication failed"
        }),
        {
          status: 502,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    const data = await paypalResponse.json();

    return new Response(
      JSON.stringify({
        ok: true,
        paypal: "connected",
        environment: env,
        token_type: data.token_type
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