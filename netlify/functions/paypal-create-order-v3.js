import crypto from "node:crypto";

/*
 * StemPlayer V3 Commerce
 *
 * Offers:
 *   standard -> USD 29.99
 *   upgrade  -> USD 20.00
 *
 * Upgrade rule:
 *   A valid StemPlayer V2 license MUST be verified
 *   server-side before a PayPal order is created.
 */

const PRODUCT = "StemPlayer";

const V3_STANDARD_PRICE = "29.99";
const V3_UPGRADE_PRICE = "20.00";

const V3_STANDARD_REFERENCE =
  "STEMPLAYER_V3_STANDARD";

const V3_UPGRADE_REFERENCE =
  "STEMPLAYER_V3_UPGRADE";

/*
 * Public key is intentionally embedded here.
 * It is NOT secret.
 *
 * This must match the Ed25519 public key used
 * by the StemPlayer desktop licensing system.
 */
const STEMPLAYER_ED25519_PUBLIC_KEY_BASE64 =
  "WTOs9AZPQIpEhyiz+0/3YbcFab8w3+r6bjgDvJtRe7w=";


/*
 * ---------------------------------------------------------
 * HTTP helpers
 * ---------------------------------------------------------
 */

function jsonResponse(body, status = 200) {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    }
  );
}


/*
 * ---------------------------------------------------------
 * PayPal
 * ---------------------------------------------------------
 */

async function getPayPalAccessToken() {
  const clientId =
    process.env.PAYPAL_CLIENT_ID;

  const clientSecret =
    process.env.PAYPAL_CLIENT_SECRET;

  const env =
    process.env.PAYPAL_ENV || "sandbox";

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing PayPal credentials"
    );
  }

  const baseUrl =
    env === "live"
      ? "https://api-m.paypal.com"
      : "https://api-m.sandbox.paypal.com";

  const basicAuth =
    Buffer.from(
      `${clientId}:${clientSecret}`
    ).toString("base64");

  const response =
    await fetch(
      `${baseUrl}/v1/oauth2/token`,
      {
        method: "POST",
        headers: {
          Authorization:
            `Basic ${basicAuth}`,
          "Content-Type":
            "application/x-www-form-urlencoded"
        },
        body:
          "grant_type=client_credentials"
      }
    );

  if (!response.ok) {
    const text =
      await response.text();

    throw new Error(
      `PayPal OAuth failed: ${response.status} ${text}`
    );
  }

  const data =
    await response.json();

  return {
    accessToken:
      data.access_token,
    baseUrl
  };
}


/*
 * ---------------------------------------------------------
 * V2 license verification
 * ---------------------------------------------------------
 *
 * Desktop canonicalization:
 *
 * json.dumps(
 *   signed_payload,
 *   sort_keys=True,
 *   separators=(",", ":"),
 *   ensure_ascii=False
 * ).encode("utf-8")
 *
 * Signed fields:
 *
 * schema
 * product
 * edition
 * license_id
 * purchase_ref
 * issued_at
 *
 * Python sort_keys=True produces:
 *
 * edition
 * issued_at
 * license_id
 * product
 * purchase_ref
 * schema
 */

function canonicalLicenseBytes(
  license
) {
  const payload = {
    edition:
      license.edition,
    issued_at:
      license.issued_at,
    license_id:
      license.license_id,
    product:
      license.product,
    purchase_ref:
      license.purchase_ref,
    schema:
      license.schema
  };

  return Buffer.from(
    JSON.stringify(payload),
    "utf8"
  );
}


function decodeStrictBase64(value) {
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    throw new Error(
      "Invalid Base64 value"
    );
  }

  const normalized =
    value.trim();

  /*
   * Python base64.b64decode(validate=True)
   * rejects malformed Base64.
   *
   * Buffer.from(..., "base64") is more
   * permissive, so validate the syntax first.
   */
  if (
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(
      normalized
    )
  ) {
    throw new Error(
      "Invalid Base64 value"
    );
  }

  return Buffer.from(
    normalized,
    "base64"
  );
}


function createStemPlayerPublicKey() {
  const rawPublicKey =
    decodeStrictBase64(
      STEMPLAYER_ED25519_PUBLIC_KEY_BASE64
    );

  if (rawPublicKey.length !== 32) {
    throw new Error(
      "Unexpected Ed25519 public key length"
    );
  }

  /*
   * Node crypto.createPublicKey() expects
   * SubjectPublicKeyInfo DER rather than a
   * bare 32-byte Ed25519 public key.
   *
   * RFC 8410 Ed25519 SPKI prefix:
   *
   * 302a300506032b6570032100
   */
  const spkiPrefix =
    Buffer.from(
      "302a300506032b6570032100",
      "hex"
    );

  const der =
    Buffer.concat([
      spkiPrefix,
      rawPublicKey
    ]);

  return crypto.createPublicKey({
    key: der,
    format: "der",
    type: "spki"
  });
}


const STEMPLAYER_PUBLIC_KEY =
  createStemPlayerPublicKey();


function requireNonEmptyString(
  license,
  field
) {
  return (
    typeof license[field] ===
      "string" &&
    license[field].trim().length > 0
  );
}


function verifyV2License(
  license
) {
  if (
    !license ||
    typeof license !== "object" ||
    Array.isArray(license)
  ) {
    return {
      valid: false,
      reason: "MALFORMED"
    };
  }

  /*
   * Match desktop structural requirements.
   */
  if (
    !Number.isInteger(
      license.schema
    ) ||
    !requireNonEmptyString(
      license,
      "product"
    ) ||
    !requireNonEmptyString(
      license,
      "edition"
    ) ||
    !requireNonEmptyString(
      license,
      "license_id"
    ) ||
    !requireNonEmptyString(
      license,
      "purchase_ref"
    ) ||
    !requireNonEmptyString(
      license,
      "issued_at"
    ) ||
    !requireNonEmptyString(
      license,
      "signature"
    )
  ) {
    return {
      valid: false,
      reason: "MALFORMED"
    };
  }

  if (license.schema !== 1) {
    return {
      valid: false,
      reason:
        "UNSUPPORTED_SCHEMA"
    };
  }

  if (
    license.product !== PRODUCT
  ) {
    return {
      valid: false,
      reason: "WRONG_PRODUCT"
    };
  }

  if (
    license.edition !== "V2"
  ) {
    return {
      valid: false,
      reason: "WRONG_EDITION"
    };
  }

  let signature;

  try {
    signature =
      decodeStrictBase64(
        license.signature
      );
  } catch {
    return {
      valid: false,
      reason: "BAD_SIGNATURE"
    };
  }

  /*
   * Ed25519 signatures are exactly 64 bytes.
   */
  if (signature.length !== 64) {
    return {
      valid: false,
      reason: "BAD_SIGNATURE"
    };
  }

  let validSignature = false;

  try {
    validSignature =
      crypto.verify(
        null,
        canonicalLicenseBytes(
          license
        ),
        STEMPLAYER_PUBLIC_KEY,
        signature
      );
  } catch {
    validSignature = false;
  }

  if (!validSignature) {
    return {
      valid: false,
      reason: "BAD_SIGNATURE"
    };
  }

  return {
    valid: true,
    license_id:
      license.license_id,
    purchase_ref:
      license.purchase_ref
  };
}


/*
 * ---------------------------------------------------------
 * Request parsing
 * ---------------------------------------------------------
 */

async function parseRequest(
  request
) {
  if (
    request.method !== "POST"
  ) {
    return {
      error: jsonResponse(
        {
          ok: false,
          error:
            "Method not allowed"
        },
        405
      )
    };
  }

  let body;

  try {
    body =
      await request.json();
  } catch {
    return {
      error: jsonResponse(
        {
          ok: false,
          error:
            "Request body must be valid JSON"
        },
        400
      )
    };
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    return {
      error: jsonResponse(
        {
          ok: false,
          error:
            "Request body must be a JSON object"
        },
        400
      )
    };
  }

  const offer =
    body.offer;

  if (
    offer !== "standard" &&
    offer !== "upgrade"
  ) {
    return {
      error: jsonResponse(
        {
          ok: false,
          error:
            "Invalid V3 offer"
        },
        400
      )
    };
  }

  if (offer === "standard") {
    return {
      offer,
      upgradeEvidence: null
    };
  }

  /*
   * Upgrade:
   *
   * Never trust license_id supplied separately
   * by the browser.
   *
   * Derive entitlement ONLY from the signed
   * V2 license.
   */
  const verification =
    verifyV2License(
      body.v2_license
    );

  if (!verification.valid) {
    return {
      error: jsonResponse(
        {
          ok: false,
          error:
            "Valid StemPlayer V2 license required for upgrade",
          license_status:
            verification.reason
        },
        403
      )
    };
  }

  return {
    offer,
    upgradeEvidence: {
      edition: "V2",
      license_id:
        verification.license_id,
      purchase_ref:
        verification.purchase_ref
    }
  };
}


/*
 * ---------------------------------------------------------
 * Netlify Function
 * ---------------------------------------------------------
 */

export default async (
  request
) => {

  try {
    const parsed =
      await parseRequest(
        request
      );

    if (parsed.error) {
      return parsed.error;
    }

    const {
      offer,
      upgradeEvidence
    } = parsed;

    const isUpgrade =
      offer === "upgrade";

    const amount =
      isUpgrade
        ? V3_UPGRADE_PRICE
        : V3_STANDARD_PRICE;

    const referenceId =
      isUpgrade
        ? V3_UPGRADE_REFERENCE
        : V3_STANDARD_REFERENCE;

    const description =
      isUpgrade
        ? "StemPlayer V3 - V2 Upgrade License"
        : "StemPlayer V3 - Standard License";

    const {
      accessToken,
      baseUrl
    } =
      await getPayPalAccessToken();

    const purchaseUnit = {
      reference_id:
        referenceId,

      description,

      amount: {
        currency_code: "USD",
        value: amount
      }
    };

    /*
     * Bind the PayPal Upgrade order to the
     * server-verified V2 entitlement.
     *
     * Capture will later read custom_id from
     * PayPal itself. It must NOT trust the
     * browser to tell it which V2 license was
     * verified.
     */
    if (isUpgrade) {
      purchaseUnit.custom_id =
        upgradeEvidence.license_id;
    }

    const orderResponse =
      await fetch(
        `${baseUrl}/v2/checkout/orders`,
        {
          method: "POST",
          headers: {
            Authorization:
              `Bearer ${accessToken}`,
            "Content-Type":
              "application/json",
            Prefer:
              "return=representation"
          },

          body: JSON.stringify({
            intent: "CAPTURE",

            purchase_units: [
              purchaseUnit
            ],

            application_context: {
              brand_name:
                "StemPlayer",

              landing_page:
                "NO_PREFERENCE",

              user_action:
                "PAY_NOW",

              shipping_preference:
                "NO_SHIPPING",

              return_url:
                "https://stemplayer-app.netlify.app/thank-you-v3.html",

              cancel_url:
                "https://stemplayer-app.netlify.app/"
            }
          })
        }
      );

    let orderData;

    try {
      orderData =
        await orderResponse.json();
    } catch {
      orderData = null;
    }

    if (!orderResponse.ok) {
      console.error(
        "V3 PayPal order creation failed:",
        orderResponse.status,
        orderData
      );

      return jsonResponse(
        {
          ok: false,
          paypal_status:
            orderResponse.status,
          error:
            "PayPal order creation failed",
          details:
            orderData
        },
        502
      );
    }

    const approvalLink =
      orderData.links?.find(
        (link) =>
          link.rel === "approve" ||
          link.rel ===
            "payer-action"
      )?.href ?? null;

    if (!approvalLink) {
      throw new Error(
        "PayPal order has no approval URL"
      );
    }

    return jsonResponse({
      ok: true,

      order_id:
        orderData.id,

      status:
        orderData.status,

      product:
        "StemPlayer V3",

      edition:
        "V3",

      offer,

      amount,

      currency:
        "USD",

      upgrade_from:
        isUpgrade
          ? {
              edition: "V2",
              license_id:
                upgradeEvidence
                  .license_id
            }
          : null,

      approval_url:
        approvalLink
    });

  } catch (error) {
    console.error(
      "paypal-create-order-v3 failed:",
      error
    );

    return jsonResponse(
      {
        ok: false,
        error:
          "Unexpected server error"
      },
      500
    );
  }
};