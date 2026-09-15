import { getStore } from "@netlify/blobs";
import {
  S3Client,
  GetObjectCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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

export default async (request) => {
  try {
    /*
     * STEP 1
     * Require the PayPal order ID.
     */
    const url = new URL(request.url);
    const orderId =
      url.searchParams.get("order_id");

    if (!orderId) {
      return jsonResponse(
        {
          ok: false,
          error: "Missing order_id"
        },
        400
      );
    }

    /*
     * STEP 2
     * Read the authoritative StemPlayer
     * commerce ledger.
     */
    const store = getStore({
      name: "stemplayer-commerce",
      consistency: "strong"
    });

    const state = await store.get(
      "state.json",
      {
        type: "json",
        consistency: "strong"
      }
    );

    if (!state) {
      throw new Error(
        "Commerce state not initialized"
      );
    }

    const processedOrder =
      state.processed_orders?.[orderId];

    /*
     * STEP 3
     * Download is allowed only after the
     * payment has completed our capture /
     * accounting flow.
     */
    if (!processedOrder?.sold_counted) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Order has not completed StemPlayer payment processing"
        },
        403
      );
    }

    /*
     * STEP 4
     * Require an issued license.
     *
     * This means the order has passed:
     * PayPal payment -> commerce ledger ->
     * StemPlayer license issuance.
     */
    if (!processedOrder.license) {
      return jsonResponse(
        {
          ok: false,
          error:
            "StemPlayer license has not been issued"
        },
        403
      );
    }

    /*
     * STEP 5
     * Validate R2 configuration.
     */
    const {
      R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY,
      R2_ENDPOINT,
      R2_BUCKET
    } = process.env;

    if (
      !R2_ACCESS_KEY_ID ||
      !R2_SECRET_ACCESS_KEY ||
      !R2_ENDPOINT ||
      !R2_BUCKET
    ) {
      throw new Error(
        "Missing R2 environment variables"
      );
    }

    /*
     * STEP 6
     * Create a short-lived signed download URL.
     */
    const client = new S3Client({
      region: "auto",
      endpoint: R2_ENDPOINT,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey:
          R2_SECRET_ACCESS_KEY
      }
    });

    const command =
      new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: "StemPlayer_V2_Setup.exe",
        ResponseContentDisposition:
          'attachment; filename="StemPlayer_V2_Setup.exe"',
        ResponseContentType:
          "application/x-msdownload"
      });

    const downloadUrl =
      await getSignedUrl(
        client,
        command,
        {
          expiresIn: 300
        }
      );

    return jsonResponse({
      ok: true,
      expires_in: 300,
      download_url: downloadUrl
    });

  } catch (error) {
    console.error(
      "R2 download authorization failed:",
      error
    );

    return jsonResponse(
      {
        ok: false,
        error:
          "Failed to authorize StemPlayer download"
      },
      500
    );
  }
};