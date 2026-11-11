import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTestDatabase } from "./helpers.js";
import { Platform, type Actor } from "../src/platform.js";
import { NotificationService } from "../src/notifications.js";

test("expiry batches release capacity once, preserve payment review and notify authorized staff", async () => {
  const {pg,db} = await createTestDatabase();
  const p = new Platform(db), feed = new NotificationService(db);
  const parent: Actor = {id:randomUUID(),role:"parent"};
  const owner: Actor = {id:randomUUID(),role:"provider"};
  const staff: Actor = {id:randomUUID(),role:"parent"};
  const admin: Actor = {id:randomUUID(),role:"admin"};
  try {
    for (const a of [parent,owner,staff,admin]) {
      await p.me(a.id,"synthetic@example.invalid");
      await p.read("UPDATE app.profiles SET role=$2 WHERE id=$1",[a.id,a.role]);
    }
    const org = await p.apply(owner,{name:"Synthetic automation",description:"Synthetic automation testing only"});
    await p.approve(admin,org.id,"approved");
    await p.setMember(owner,org.id,staff.id,true);
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
    await p.read("UPDATE app.bookings SET payment_due_at=now()-interval '1 minute'");
    await p.read("UPDATE app.bookings SET state='PAYMENT_CHECKING' WHERE id=$1",[bookings[2]]);
    await assert.rejects(() => p.expire(101),/batch size/);
    assert.equal(await p.expire(1),1);
    assert.equal((await p.read("SELECT allocated FROM app.sessions WHERE id=$1",[activity.sessionId]))[0].allocated,2);
    assert.equal(await p.expire(1),1);
    assert.equal(await p.expire(1),0);
    assert.equal((await p.read("SELECT allocated FROM app.sessions WHERE id=$1",[activity.sessionId]))[0].allocated,1);
    assert.equal((await p.read("SELECT state FROM app.bookings WHERE id=$1",[bookings[2]]))[0].state,"PAYMENT_CHECKING");
    assert.equal((await p.read("SELECT count(*)::int AS n FROM app.audit WHERE action='booking.expired'"))[0].n,2);
    const first = await feed.list(staff,{page:1,pageSize:1});
    const second = await feed.list(staff,{page:2,pageSize:1});
    assert.equal(first.items.length,1);
    assert.equal(first.items[0].event,"booking.expired");
    assert.equal(first.items[0].workspace,"provider");
    assert.notEqual(first.items[0].id,second.items[0].id);
    assert.equal(first.pages,first.total);
    assert.equal((await feed.list(staff,{page:100,pageSize:20})).items.length,0);
    await p.setMember(owner,org.id,staff.id,false);
    assert.equal((await feed.list(staff)).total,0);
    await feed.markRead(staff,null);
    assert.equal((await p.read("SELECT count(*)::int AS n FROM app.notifications WHERE recipient_id=$1 AND read_at IS NOT NULL",[staff.id]))[0].n,0);
  } finally { await pg.close(); }
});
