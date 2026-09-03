import crypto from "node:crypto";

function canonicalLicensePayload(payload) {
  // Phải khớp Python:
  // json.dumps(..., sort_keys=True, separators=(",", ":"), ensure_ascii=False)
  const sortedPayload = {
    edition: payload.edition,
    issued_at: payload.issued_at,
    license_id: payload.license_id,
    product: payload.product,
    purchase_ref: payload.purchase_ref,
    schema: payload.schema
  };

  return JSON.stringify(sortedPayload);
}

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

    const privateKeyB64 =
    process.env.STEMPLAYER_V2_PRIVATE_KEY_B64;

    if (!privateKeyB64) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Missing StemPlayer signing key"
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    // 1. Verify payment directly with PayPal
    const { accessToken, baseUrl } =
      await getPayPalAccessToken();

    const orderResponse = await fetch(
      `${baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    const orderData = await orderResponse.json();

    if (!orderResponse.ok) {
      return new Response(
        JSON.stringify({
          ok: false,
          paypal_status: orderResponse.status,
          error: "Unable to verify PayPal order"
        }),
        {
          status: 502,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    if (orderData.status !== "COMPLETED") {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Payment is not completed",
          status: orderData.status
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    const capture =
      orderData.purchase_units?.[0]
        ?.payments?.captures?.[0];

    if (!capture || capture.status !== "COMPLETED") {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Completed PayPal capture not found"
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    if (
      capture.amount?.currency_code !== "USD" ||
      capture.amount?.value !== "5.00"
    ) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Unexpected payment amount"
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    // 2. Create license payload
    const licensePayload = {
      schema: 1,
      product: "StemPlayer",
      edition: "V2",
      license_id:
        "SPV2-" +
        crypto.randomBytes(6)
          .toString("hex")
          .toUpperCase(),
      purchase_ref: capture.id,
      issued_at: new Date().toISOString()
    };

    // 3. Canonical JSON matching Python verifier
    const canonical = canonicalLicensePayload(
      licensePayload
    );

    // 4. Sign with Ed25519 private key
    const privateKeyPemBytes =
    Buffer.from(privateKeyB64, "base64");

    const privateKey = crypto.createPrivateKey({
    key: privateKeyPemBytes,
    format: "pem"
    });

    const signature = crypto.sign(
      null,
      Buffer.from(canonical, "utf8"),
      privateKey
    );

    // 5. Final V2 license
    const license = {
      ...licensePayload,
      signature: signature.toString("base64")
    };

    return new Response(
      JSON.stringify(license, null, 2),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition":
            'attachment; filename="StemPlayer_V2.license"',
          "Cache-Control": "no-store"
        }
      }
    );
  } catch (error) {
    console.error("License issuance failed:", error);

    return new Response(
      JSON.stringify({
        ok: false,
        error: "License issuance failed"
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
};