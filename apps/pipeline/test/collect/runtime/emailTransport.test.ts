/**
 * Tests the #26/#29 SMTP decision (see `collect/runtime/emailTransport.ts`'s
 * doc comment): `connect()` always throws a clear, distinguishable error —
 * never a silent no-op, never a crash with an unrelated message.
 */
import { expect, it } from "vitest";
import { EmailExporter } from "../../../src/collect/exporters/email.js";
import { createPaper } from "../../../src/collect/model/paper.js";
import {
  createUnavailableEmailTransport,
  SMTP_UNAVAILABLE_MESSAGE,
} from "../../../src/collect/runtime/emailTransport.js";

it("connect() always throws SMTP_UNAVAILABLE_MESSAGE", async () => {
  const transport = createUnavailableEmailTransport();
  await expect(transport.connect("smtp.example.com", 587, 30_000)).rejects.toThrow(
    SMTP_UNAVAILABLE_MESSAGE,
  );
});

it("EmailExporter.export() never touches the transport when server/to are unconfigured (OUT-15 no-op) — connect() is NOT called", async () => {
  const transport = createUnavailableEmailTransport();
  const exporter = new EmailExporter({ enabled: true }, { smtp: {}, transport });
  const paper = createPaper({
    title: "t",
    authors: ["a"],
    abstract: "x",
    url: "https://arxiv.org/abs/1",
    publishedDate: "2026-01-01",
    source: "arxiv",
  });

  const result = await exporter.export([paper]);
  expect(result).toBeNull();
});

it("EmailExporter.export() surfaces the SMTP-unavailable error when email IS configured", async () => {
  const transport = createUnavailableEmailTransport();
  const exporter = new EmailExporter(
    { enabled: true },
    { smtp: { server: "smtp.example.com", to: "me@example.com" }, transport },
  );
  const paper = createPaper({
    title: "t",
    authors: ["a"],
    abstract: "x",
    url: "https://arxiv.org/abs/1",
    publishedDate: "2026-01-01",
    source: "arxiv",
  });

  await expect(exporter.export([paper])).rejects.toThrow(SMTP_UNAVAILABLE_MESSAGE);
});
