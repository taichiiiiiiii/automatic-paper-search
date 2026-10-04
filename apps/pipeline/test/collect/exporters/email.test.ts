/**
 * Port of `paperpilot/tests/test_email_exporter.py` and the Email cases of
 * `test_exporters.py`.
 */
import { expect, it } from "vitest";
import {
  EmailExporter,
  type SmtpClient,
  type SmtpClientFactory,
} from "../../../src/collect/exporters/email.js";
import { createPaper, type Paper } from "../../../src/collect/model/paper.js";

function mkPaper(title: string, score = 50.0): Paper {
  return createPaper({
    title,
    authors: ["A"],
    abstract: "abs",
    url: "http://x",
    publishedDate: "2026-04-10",
    source: "arxiv",
    totalScore: score,
  });
}

const BASE_SMTP = {
  server: "smtp.example.com",
  port: 587,
  user: "me",
  password: "pass",
  to: "inbox@example.com",
  use_tls: true,
};

class FakeClient implements SmtpClient {
  calls: string[] = [];
  starttlsError: Error | null = null;
  loginError: Error | null = null;
  sendError: Error | null = null;
  sentMessage: Parameters<SmtpClient["sendMessage"]>[0] | null = null;

  async starttls(): Promise<void> {
    this.calls.push("starttls");
    if (this.starttlsError) throw this.starttlsError;
  }
  async login(user: string, password: string): Promise<void> {
    this.calls.push(`login:${user}:${password}`);
    if (this.loginError) throw this.loginError;
  }
  async sendMessage(message: Parameters<SmtpClient["sendMessage"]>[0]): Promise<void> {
    this.calls.push("sendMessage");
    this.sentMessage = message;
    if (this.sendError) throw this.sendError;
  }
  async quit(): Promise<void> {
    this.calls.push("quit");
  }
}

function factoryFor(client: FakeClient): SmtpClientFactory {
  return { connect: async () => client };
}

it("test_no_papers_returns_none", async () => {
  const exp = new EmailExporter(
    { enabled: true },
    { smtp: BASE_SMTP, transport: factoryFor(new FakeClient()) },
  );
  expect(await exp.export([])).toBeNull();
});

it("test_missing_settings_no_op", async () => {
  const exp = new EmailExporter(
    { enabled: true },
    { smtp: { to: "a@b.c" }, transport: factoryFor(new FakeClient()) },
  );
  expect(await exp.export([mkPaper("A")])).toBeNull();
});

it("test_send_invokes_smtp_with_tls", async () => {
  const client = new FakeClient();
  const papers = [mkPaper("Paper A"), mkPaper("Paper B")];
  const exp = new EmailExporter(
    { enabled: true, max_items: 10 },
    { smtp: BASE_SMTP, transport: factoryFor(client) },
  );
  const result = await exp.export(papers);
  expect(result).toBe("email");
  expect(client.calls).toEqual(["starttls", "login:me:pass", "sendMessage", "quit"]);
  expect(client.sentMessage?.to).toBe("inbox@example.com");
  expect(client.sentMessage?.subject).toContain("PaperPilot");
  expect(client.sentMessage?.text).toContain("Paper A");
  expect(client.sentMessage?.text).toContain("Paper B");
});

it("test_respects_max_items", async () => {
  const client = new FakeClient();
  const papers = Array.from({ length: 30 }, (_, i) => mkPaper(`P${i}`));
  const exp = new EmailExporter(
    { enabled: true, max_items: 3 },
    { smtp: BASE_SMTP, transport: factoryFor(client) },
  );
  await exp.export(papers);
  const body = client.sentMessage?.text ?? "";
  const titlesSeen = new Set(body.match(/\bP\d+\b/g) ?? []);
  expect(titlesSeen.has("P0") && titlesSeen.has("P1") && titlesSeen.has("P2")).toBe(true);
  for (let i = 3; i < 30; i++) expect(titlesSeen.has(`P${i}`)).toBe(false);
});

it("test_no_tls_branch", async () => {
  const client = new FakeClient();
  const exp = new EmailExporter(
    { enabled: true },
    { smtp: { ...BASE_SMTP, use_tls: false, port: 25 }, transport: factoryFor(client) },
  );
  await exp.export([mkPaper("Solo")]);
  expect(client.calls).not.toContain("starttls");
  expect(client.calls.filter((c) => c.startsWith("login:")).length).toBe(1);
});

it("test_no_auth_branch", async () => {
  const client = new FakeClient();
  const exp = new EmailExporter(
    { enabled: true },
    { smtp: { ...BASE_SMTP, user: "", password: "" }, transport: factoryFor(client) },
  );
  await exp.export([mkPaper("Solo")]);
  expect(client.calls.some((c) => c.startsWith("login:"))).toBe(false);
  expect(client.calls).toContain("sendMessage");
});

it("test_smtp_exception_returns_none", async () => {
  const exp = new EmailExporter(
    { enabled: true },
    {
      smtp: BASE_SMTP,
      transport: {
        connect: async () => {
          throw new Error("connection refused");
        },
      },
    },
  );
  await expect(exp.export([mkPaper("x")])).rejects.toThrow("connection refused");
});

it("test_starttls_ssl_error_quits_connection", async () => {
  const client = new FakeClient();
  client.starttlsError = new Error("tls handshake failed");
  const exp = new EmailExporter(
    { enabled: true },
    { smtp: BASE_SMTP, transport: factoryFor(client) },
  );
  await expect(exp.export([mkPaper("x")])).rejects.toThrow("tls handshake failed");
  expect(client.calls).toContain("quit");
});

it("test_login_authentication_error_quits_connection", async () => {
  const client = new FakeClient();
  client.loginError = new Error("bad creds");
  const exp = new EmailExporter(
    { enabled: true },
    { smtp: BASE_SMTP, transport: factoryFor(client) },
  );
  await expect(exp.export([mkPaper("x")])).rejects.toThrow("bad creds");
  expect(client.calls).toContain("quit");
});

it("test_html_body_omits_link_for_non_http_scheme_url", () => {
  const paper = mkPaper("Malicious Paper");
  paper.url = "javascript:alert(1)";
  const html = EmailExporter.htmlBody([paper], "2026-04-10");
  expect(html).not.toContain("<a href=");
  expect(html).not.toContain("javascript:");
  expect(html).toContain("Malicious Paper");
});

it("test_html_body_keeps_link_for_https_url", () => {
  const paper = mkPaper("Legit Paper");
  paper.url = "https://arxiv.org/abs/2604.00001";
  const html = EmailExporter.htmlBody([paper], "2026-04-10");
  expect(html).toContain("<a href='https://arxiv.org/abs/2604.00001'>Legit Paper</a>");
});

it("test_html_body_omits_link_for_data_scheme_url", () => {
  const paper = mkPaper("Data URI Paper");
  paper.url = "data:text/html,<script>alert(1)</script>";
  const html = EmailExporter.htmlBody([paper], "2026-04-10");
  expect(html).not.toContain("<a href=");
  expect(html).not.toContain("data:text/html");
});

it("test_email_reports_the_count_it_actually_delivered", async () => {
  const client = new FakeClient();
  const papers = Array.from({ length: 8 }, (_, i) => mkPaper(`P${i}`));
  const exp = new EmailExporter(
    { enabled: true, max_items: 2 },
    { smtp: BASE_SMTP, transport: factoryFor(client) },
  );
  expect(await exp.export(papers)).toBe("email");
  expect(exp.lastDelivered).toBe(2);
});

it("test_email_reports_no_delivery_when_smtp_fails", async () => {
  const client = new FakeClient();
  client.sendError = new Error("rejected");
  const exp = new EmailExporter(
    { enabled: true, max_items: 10 },
    { smtp: { server: BASE_SMTP.server, to: BASE_SMTP.to }, transport: factoryFor(client) },
  );
  await expect(exp.export([mkPaper("x")])).rejects.toThrow("rejected");
  expect(exp.lastDelivered).toBe(0);
});
