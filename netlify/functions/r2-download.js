const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

exports.handler = async () => {
  try {
    const {
      R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY,
      R2_ENDPOINT,
      R2_BUCKET,
    } = process.env;

    if (
      !R2_ACCESS_KEY_ID ||
      !R2_SECRET_ACCESS_KEY ||
      !R2_ENDPOINT ||
      !R2_BUCKET
    ) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Missing R2 environment variables",
        }),
      };
    }

    const client = new S3Client({
      region: "auto",
      endpoint: R2_ENDPOINT,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    });

    const command = new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: "StemPlayer_V2_Setup.exe",
      ResponseContentDisposition:
        'attachment; filename="StemPlayer_V2_Setup.exe"',
      ResponseContentType: "application/x-msdownload",
    });

    const downloadUrl = await getSignedUrl(client, command, {
      expiresIn: 300,
    });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({
        ok: true,
        expires_in: 300,
        download_url: downloadUrl,
      }),
    };
  } catch (error) {
    console.error("R2 presign error:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Failed to create R2 download URL",
      }),
    };
  }
};