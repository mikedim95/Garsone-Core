const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function decodeRasterImage(input: string) {
  const encoded = input.replace(/^data:[^,]*,/, "").replace(/\s/g, "");
  const invalid = () => Object.assign(new Error("Upload a PNG, JPEG, GIF or WebP image up to 5 MiB"), { statusCode: 400 });
  if (!encoded || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw invalid();
  const buffer = Buffer.from(encoded, "base64");
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw invalid();
  let mimeType: string;
  let extension: string;
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mimeType = "image/png"; extension = "png";
  } else if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    mimeType = "image/jpeg"; extension = "jpg";
  } else if (["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) {
    mimeType = "image/gif"; extension = "gif";
  } else if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    mimeType = "image/webp"; extension = "webp";
  } else { throw invalid(); }
  return { buffer, mimeType, extension };
}

export function isPublicImageUrl(value: string): boolean {
  try {
    if (value.startsWith("/uploads/") && !value.includes("\\")) {
      const url = new URL(value, "https://local.invalid");
      return url.origin === "https://local.invalid" && url.pathname.startsWith("/uploads/");
    }
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}
