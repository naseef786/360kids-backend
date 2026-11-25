import test from "node:test";
import assert from "node:assert/strict";
import { emailConfig, sendEmail } from "../src/email.js";

const message = { to: "parent@example.invalid", subject: "Booking request update", text: "Your request status changed. Sign in to view details." };

test("email stays disabled without SMTP credentials or network activity", async () => {
  let called = false;
  assert.equal(await sendEmail(message, {}, async () => { called = true; return {accepted:[]}; }), "disabled");
  assert.equal(called, false);
  assert.throws(() => emailConfig({EMAIL_DELIVERY_MODE:"smtp",EMAIL_SMTP_HOST:"mail.example.invalid",EMAIL_SMTP_PORT:"465",EMAIL_SMTP_USER:"sender@example.invalid",EMAIL_FROM:"sender@example.invalid"}), /not configured/);
});

test("SMTP adapter uses authenticated implicit TLS and a verified sender", async () => {
  const env = {EMAIL_DELIVERY_MODE:"smtp",EMAIL_SMTP_HOST:"mail.example.invalid",EMAIL_SMTP_PORT:"465",EMAIL_SMTP_USER:"sender@example.invalid",EMAIL_SMTP_PASSWORD:"synthetic-test-only",EMAIL_FROM:"sender@example.invalid"};
  assert.equal(await sendEmail(message, env, async (options, mail) => {
    assert.equal(options?.host,"mail.example.invalid");
    assert.equal(options?.port,465);
    assert.equal(options?.secure,true);
    assert.deepEqual(options?.tls,{rejectUnauthorized:true,servername:"mail.example.invalid"});
    assert.deepEqual(mail,{...message,from:"sender@example.invalid"});
    return {accepted:[message.to]};
  }),"accepted");
  assert.throws(() => emailConfig({...env,EMAIL_SMTP_PORT:"587"}),/implicit TLS/);
  assert.throws(() => emailConfig({...env,EMAIL_FROM:"other@example.invalid"}),/sender identity/);
});

test("email adapter rejects header injection and an unaccepted SMTP result", async () => {
  await assert.rejects(() => sendEmail({...message,subject:"Update\r\nBcc: attacker@example.invalid"},{}),/invalid/);
  await assert.rejects(() => sendEmail({...message,to:"bad\n@example.invalid"},{}),/invalid/);
  await assert.rejects(() => sendEmail({...message,to:"parent@example.invalid,other@example.invalid"},{}),/invalid/);
  const env = {EMAIL_DELIVERY_MODE:"smtp",EMAIL_SMTP_HOST:"mail.example.invalid",EMAIL_SMTP_PORT:"465",EMAIL_SMTP_USER:"sender@example.invalid",EMAIL_SMTP_PASSWORD:"synthetic-test-only",EMAIL_FROM:"sender@example.invalid"};
  await assert.rejects(() => sendEmail(message,env,async () => ({accepted:[]})),/did not accept/);
});

test("branded HTML embeds the actual PNG logo inline", async () => {
  const env = {EMAIL_DELIVERY_MODE:"smtp",EMAIL_SMTP_HOST:"mail.example.invalid",EMAIL_SMTP_PORT:"465",EMAIL_SMTP_USER:"sender@example.invalid",EMAIL_SMTP_PASSWORD:"synthetic-test-only",EMAIL_FROM:"sender@example.invalid"};
  await assert.rejects(() => sendEmail({...message,brandLogo:true,html:"<p>No image</p>"},env),/logo reference/);
  assert.equal(await sendEmail({...message,brandLogo:true,html:'<img src="cid:360-kids-logo@360kidsactivity.com" alt="360 Kids Activity">'},env,async (_options,mail) => {
    assert.equal(mail.attachments?.length,1);
    assert.equal(mail.attachments?.[0].cid,"360-kids-logo@360kidsactivity.com");
    assert.equal(mail.attachments?.[0].contentType,"image/png");
    assert.equal(mail.attachments?.[0].content.subarray(0,8).toString("hex"),"89504e470d0a1a0a");
    assert.equal(mail.attachments?.[0].contentDisposition,"inline");
    return {accepted:[message.to]};
  }),"accepted");
});
