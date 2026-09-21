// One bounded child process per ticket isolates a stalled Bluetooth device.
import { constants, openSync, fstatSync, writeSync, closeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const device = process.argv[2];
if (!device || !/^\/dev\/(rfcomm\d+|pts\/\d+)$/.test(device)) throw new Error("Invalid printer device");
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const ticket = Buffer.concat(chunks);
execFileSync("stty", ["-F", device, "raw", "-echo", "-ixon", "-ixoff"], { timeout: 5000 });
const fd = openSync(device, constants.O_WRONLY | constants.O_NOCTTY | constants.O_NONBLOCK);
try {
  if (!fstatSync(fd).isCharacterDevice()) throw new Error("Printer must be a character device");
  let offset = 0;
  while (offset < ticket.length) {
    try {
      const written = writeSync(fd, ticket, offset, ticket.length - offset);
      if (!written) throw new Error("Printer accepted zero bytes");
      offset += written;
    } catch (error: any) {
      if (error.code !== "EAGAIN" && error.code !== "EWOULDBLOCK") throw error;
      await delay(50);
    }
  }
} finally { closeSync(fd); }
