import test from "node:test";
import assert from "node:assert/strict";
import { grantFixtureRoles, grantFixtureBranchManager } from "./support/permissions.js";
import { randomUUID } from "node:crypto";
import { createTestDatabase } from "./helpers.js";
import { Platform, type Actor } from "../src/platform.js";
import { NotificationService } from "../src/notifications.js";

test("expiry batches close request, offer, payment and review windows once", async () => {
  const {pg,db} = await createTestDatabase();
  const p = new Platform(db,true), feed = new NotificationService(db);
  const parent: Actor = {id:randomUUID(),role:"parent"};
  const owner: Actor = {id:randomUUID(),role:"provider"};
  const staff: Actor = {id:randomUUID(),role:"parent"};
  const admin: Actor = {id:randomUUID(),role:"admin"};
  try {
    for (const a of [parent,owner,staff,admin]) {
      await p.me(a.id,"synthetic@example.invalid");
      await grantFixtureRoles(p,a);
      await p.read("UPDATE app.profiles SET role=$2 WHERE id=$1",[a.id,a.role]);
    }
    const org = await p.apply(owner,{name:"Synthetic automation",description:"Synthetic automation testing only"});
    await p.approve(admin,org.id,"approved");
    await p.setMember(owner,org.id,staff.id,true);
    await grantFixtureBranchManager(p,org.id,staff.id);
    const activity = await p.createActivity(admin,{
      providerId:org.id,title:"Synthetic session",description:"Synthetic testing only",category:"Sports",area:"Dubai",
      minAge:1,maxAge:17,priceFils:10000,policy:"Synthetic test terms",published:true,
      startsAt:"2030-05-01T12:00:00Z",cutoffAt:"2030-04-30T12:00:00Z",capacity:3,
    });
    const bookings: string[] = [];
    await p.save(parent,activity.id,true);
    assert.equal((await p.activity(activity.id,parent)).is_saved,true);
    assert.equal((await p.activity(activity.id,staff)).is_saved,false);
    assert.equal((await p.activity(activity.id)).is_saved,false);
    assert.equal((await p.list("activities",parent,{page:1,pageSize:1})).items[0].is_saved,true);
    assert.equal((await p.list("activities",{id:"",role:"public"},{page:1,pageSize:1})).items[0].is_saved,false);
    for (let i=0;i<3;i++) {
      const child = await p.addChild(parent,{firstName:"Synthetic",birthDate:"2018-01-01"});
      const b = await p.request(parent,`synthetic-request-${i}`,{sessionId:activity.sessionId,activityVersion:1,childIds:[child.id],policyAccepted:true});
      await p.act(staff,`synthetic-accept-${i}`,b.id,{action:"accept",version:1});
      bookings.push(b.id);
    }
    await p.act(parent,"synthetic-proof",bookings[2],{action:"proof",version:2,reference:"SYNTHETIC-UNVERIFIED"});
    await p.read("UPDATE app.bookings SET payment_due_at=now()-interval '1 minute' WHERE state='PAYMENT_DUE'");
    await p.read("UPDATE app.bookings SET review_due_at=now()-interval '1 minute' WHERE id=$1",[bookings[2]]);
    await assert.rejects(() => p.act(admin,"late-review-verify",bookings[2],{action:"verify",version:3}),/review window is closed/);
    await assert.rejects(() => p.expire(101),/batch size/);
    assert.equal(await p.expire(1),1);
    assert.equal((await p.read("SELECT allocated FROM app.sessions WHERE id=$1",[activity.sessionId]))[0].allocated,2);
    assert.equal(await p.expire(1),1);
    assert.equal(await p.expire(1),1);
    assert.equal(await p.expire(1),0);
    assert.equal((await p.read("SELECT allocated FROM app.sessions WHERE id=$1",[activity.sessionId]))[0].allocated,0);
    assert.equal((await p.read("SELECT state FROM app.bookings WHERE id=$1",[bookings[2]]))[0].state,"EXPIRED");
    await assert.rejects(() => p.act(admin,"post-expiry-verify",bookings[2],{action:"verify",version:4}),/No payment is awaiting review/);
    assert.equal((await p.read("SELECT count(*)::int AS n FROM app.audit WHERE action='booking.expired'"))[0].n,2);
    assert.equal((await p.read("SELECT count(*)::int AS n FROM app.payment_exceptions WHERE booking_id=$1 AND status='open'",[bookings[2]]))[0].n,1);
    assert.equal((await p.read("SELECT status FROM app.payments WHERE booking_id=$1",[bookings[2]]))[0].status,"submitted");
    const exceptions = await p.list("payment-exceptions",admin,{page:1,pageSize:1});
    assert.equal(exceptions.total,1);
    assert.equal(exceptions.items[0].reference,"SYNTHETIC-UNVERIFIED");
    await assert.rejects(() => p.list("payment-exceptions",parent,{page:1,pageSize:20}),/Capability required/);
    const requestChild = await p.addChild(parent,{firstName:"Synthetic",birthDate:"2018-01-01"});
    const pending = await p.request(parent,"synthetic-pending",{sessionId:activity.sessionId,activityVersion:1,childIds:[requestChild.id],policyAccepted:true});
    await p.read("UPDATE app.bookings SET response_due_at=now() WHERE id=$1",[pending.id]);
    await assert.rejects(() => p.act(staff,"late-accept",pending.id,{action:"accept",version:1}),/no longer actionable/);
    assert.equal(await p.expire(1),1);
    const offerChild = await p.addChild(parent,{firstName:"Synthetic",birthDate:"2018-01-01"});
    const offered = await p.request(parent,"synthetic-offered",{sessionId:activity.sessionId,activityVersion:1,childIds:[offerChild.id],policyAccepted:true});
    await p.act(staff,"synthetic-offer",offered.id,{action:"offer",version:1,amountFils:9000,reason:"Synthetic revised total"});
    assert.equal((await p.read("SELECT allocated FROM app.sessions WHERE id=$1",[activity.sessionId]))[0].allocated,1);
    await p.read("UPDATE app.bookings SET offer=jsonb_set(offer,'{expiresAt}',to_jsonb((now()-interval '1 minute')::text)) WHERE id=$1",[offered.id]);
    await assert.rejects(() => p.act(parent,"late-offer-accept",offered.id,{action:"accept-offer",version:2}),/window is closed/);
    assert.equal(await p.expire(1),1);
    assert.equal((await p.read("SELECT allocated FROM app.sessions WHERE id=$1",[activity.sessionId]))[0].allocated,0);
    const first = await feed.list(staff,{page:1,pageSize:1});
    const second = await feed.list(staff,{page:2,pageSize:1});
    assert.equal(first.items.length,1);
    assert.equal(first.items[0].event,"booking.expired");
    assert.equal(first.items[0].workspace,"provider");
    assert.notEqual(first.items[0].id,second.items[0].id);
    assert.equal(first.pages,first.total);
    assert.equal((await feed.list(staff,{page:100,pageSize:20})).items.length,0);
    const reminderChild = await p.addChild(parent,{firstName:"Synthetic",birthDate:"2018-01-01"});
    const reminderBooking = await p.request(parent,"synthetic-reminder",{sessionId:activity.sessionId,activityVersion:1,childIds:[reminderChild.id],policyAccepted:true});
    await p.read("UPDATE app.bookings SET created_at=now()-interval '2 hours',response_due_at=now()+interval '30 minutes' WHERE id=$1",[reminderBooking.id]);
    assert.equal(await p.remind(),1);
    assert.equal(await p.remind(),0);
    await p.act(staff,"reminder-accept",reminderBooking.id,{action:"accept",version:1});
    await p.read("UPDATE app.bookings SET payment_started_at=now()-interval '2 hours',payment_due_at=now()+interval '30 minutes' WHERE id=$1",[reminderBooking.id]);
    assert.equal(await p.remind(),1);
    await p.act(parent,"reminder-proof",reminderBooking.id,{action:"proof",version:2,reference:"SYNTHETIC-REMINDER"});
    await p.read("UPDATE app.payments SET submitted_at=now()-interval '2 hours' WHERE booking_id=$1",[reminderBooking.id]);
    await p.read("UPDATE app.bookings SET review_due_at=now()+interval '30 minutes' WHERE id=$1",[reminderBooking.id]);
    assert.equal(await p.remind(),1);
    const offerReminderChild = await p.addChild(parent,{firstName:"Synthetic",birthDate:"2018-01-01"});
    const offerReminder = await p.request(parent,"synthetic-offer-reminder",{sessionId:activity.sessionId,activityVersion:1,childIds:[offerReminderChild.id],policyAccepted:true});
    await p.act(staff,"reminder-offer",offerReminder.id,{action:"offer",version:1,amountFils:9000,reason:"Synthetic revised total"});
    await p.read("UPDATE app.bookings SET offer=jsonb_set(jsonb_set(offer,'{issuedAt}',to_jsonb((now()-interval '2 hours')::text)),'{expiresAt}',to_jsonb((now()+interval '30 minutes')::text)) WHERE id=$1",[offerReminder.id]);
    assert.equal(await p.remind(),1);
    assert.equal(await p.remind(),0);
    assert.equal((await p.read("SELECT count(*)::int AS n FROM app.booking_reminders"))[0].n,4);
    assert.equal((await p.read("SELECT count(*)::int AS n FROM app.outbox WHERE event LIKE 'booking.%_reminder'"))[0].n,4);
    await p.setMember(owner,org.id,staff.id,false);
    assert.equal((await feed.list(staff)).total,0);
    await feed.markRead(staff,null);
    assert.equal((await p.read("SELECT count(*)::int AS n FROM app.notifications WHERE recipient_id=$1 AND read_at IS NOT NULL",[staff.id]))[0].n,0);
  } finally { await pg.close(); }
});
