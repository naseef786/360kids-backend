import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createTestDatabase } from "./helpers.js";
import { Platform, type Actor } from "../src/platform.js";
import { NotificationService } from "../src/notifications.js";
import { createApp } from "../src/app.js";

const denied = (error: unknown) => [403,404].includes((error as {status:number}).status);

test("explicit capabilities enforce finance separation, branch scope, assignment and revocation through SQL and HTTP", async () => {
  const {pg,db} = await createTestDatabase();
  const p = new Platform(db,true), feed = new NotificationService(db);
  const actors: Record<string,Actor> = Object.fromEntries(
    ["parent","owner","otherOwner","admin","finance","support","content","manager","booker","writer","unscoped"]
      .map(name => [name,{id:randomUUID(),role:name === "admin" ? "admin" : "parent",assuranceLevel:"aal2"}]),
  );
  let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
  try {
    for (const actor of Object.values(actors)) {
      await p.me(actor.id,"synthetic@example.invalid");
      await p.read("UPDATE app.profiles SET role=$2 WHERE id=$1",[actor.id,actor.role]);
    }
    for (const role of ["finance","support","content"]) await p.read(
      "INSERT INTO app.platform_role_grants(user_id,role,granted_by,reason) VALUES($1,$2,$3,'Synthetic explicit grant')",
      [actors[role].id,role,actors.admin.id],
    );
    assert.deepEqual((await p.me(actors.admin.id,"synthetic@example.invalid")).capabilities,[]);
    const org = await p.apply(actors.owner,{name:"Synthetic provider",description:"Synthetic permissions test"});
    const otherOrg = await p.apply(actors.otherOwner,{name:"Synthetic other provider",description:"Synthetic isolation test"});
    await p.approve(actors.admin,org.id,"approved");
    await p.approve(actors.admin,otherOrg.id,"approved");
    const branchB = (await p.createBranch(actors.owner,org.id,"Synthetic second branch")).id;
    assert.equal((await p.branches(actors.owner,org.id,{page:1,pageSize:1})).total,2);
    await assert.rejects(() => p.createBranch(actors.admin,org.id,"Unauthorized branch"),denied);
    await assert.rejects(() => p.createBranch({...actors.owner,assuranceLevel:"aal1"},org.id,"No step-up"),/Step-up/);
    await assert.rejects(() => p.branches(actors.otherOwner,org.id,{page:1,pageSize:20}),denied);
    for (const name of ["manager","booker","writer","unscoped"]) await p.setMember(actors.owner,org.id,actors[name].id,true);
    await assert.rejects(() => p.setMember(actors.admin,org.id,actors.booker.id,false),denied);
    await assert.rejects(() => p.list("members",actors.admin,{page:1,pageSize:20},{providerId:org.id}),denied);
    for (const [name,role] of [["manager","branch_manager"],["booker","booking_staff"],["writer","content_staff"]]) {
      await p.setBranchRole(actors.owner,org.id,org.id,actors[name].id,role as "branch_manager" | "booking_staff" | "content_staff",true);
    }
    const draft = {providerId:org.id,title:"Synthetic activity",description:"Synthetic branch activity",category:"Arts",area:"Dubai",minAge:1,maxAge:17,
      priceFils:10000,policy:"Synthetic accepted policy",published:true,startsAt:"2030-05-01T12:00:00Z",cutoffAt:"2030-04-30T12:00:00Z",capacity:8};
    const activityA = await p.createActivity(actors.content,draft);
    const activityB = await p.createActivity(actors.content,{...draft,branchId:branchB});
    // Delegated content operators can select approved providers without a legacy admin role.
    assert.equal((await p.list("providers",actors.content,{page:1,pageSize:1},{status:"approved"})).total,2);
    assert.equal((await p.list("providers",actors.finance,{page:1,pageSize:1},{status:"approved"})).total,0);
    const bookingIds: string[] = [];
    for (const activity of [activityA,activityA,activityB]) {
      const child = await p.addChild(actors.parent,{firstName:"Synthetic",birthDate:"2018-01-01"});
      const b = await p.request(actors.parent,randomUUID(),{sessionId:activity.sessionId,activityVersion:1,childIds:[child.id],policyAccepted:true});
      bookingIds.push(b.id);
    }
    const [bookingA,unassignedA,bookingB] = bookingIds;
    await p.setBookingAssignment(actors.owner,org.id,bookingA,actors.booker.id,true);
    await assert.rejects(() => p.setBranchRole(actors.admin,org.id,org.id,actors.unscoped.id,"booking_staff",true),denied);
    await assert.rejects(() => p.setBranchRole({...actors.owner,assuranceLevel:"aal1"},org.id,org.id,actors.unscoped.id,"booking_staff",true),/Step-up/);
    await assert.rejects(() => p.setBranchRole(actors.owner,org.id,otherOrg.id,actors.unscoped.id,"booking_staff",true),denied);
    await assert.rejects(() => p.setBookingAssignment(actors.owner,org.id,bookingB,actors.booker.id,true),denied);
    await assert.rejects(() => p.setBookingAssignment(actors.otherOwner,org.id,bookingA,actors.booker.id,true),denied);
    await p.setBookingAssignment(actors.owner,org.id,bookingA,actors.booker.id,true);
    assert.equal((await p.read("SELECT count(*)::int AS n FROM app.audit WHERE action='booking_assignment.changed' AND subject_id=$1",[bookingA]))[0].n,1);
    assert.equal((await p.branchRoles(actors.owner,org.id,org.id,{page:1,pageSize:1})).total,3);
    assert.equal((await p.bookingAssignments(actors.owner,org.id,bookingA,{page:1,pageSize:1})).total,1);
    await assert.rejects(() => p.branchRoles(actors.admin,org.id,org.id,{page:1,pageSize:20}),denied);

    assert.equal((await p.list("bookings",actors.owner,{page:1,pageSize:1})).total,3);
    assert.equal((await p.list("bookings",actors.manager,{page:1,pageSize:1},{scope:"partner"})).total,2);
    assert.equal((await p.list("bookings",actors.booker,{page:1,pageSize:1})).total,1);
    const preRoster = (await p.booking(actors.manager,bookingA)).snapshot.children;
    assert.equal(preRoster[0].firstName,"Participant 1");
    assert.equal(preRoster[0].age,12);
    assert.equal(preRoster[0].id,undefined);
    assert.deepEqual((await p.booking(actors.finance,bookingA)).snapshot.children,[]);
    assert.equal((await p.booking(actors.parent,bookingA)).snapshot.children[0].firstName,"Synthetic");
    assert.equal((await p.list("bookings",actors.manager,{page:1,pageSize:20})).items[0].snapshot.children[0].id,undefined);
    for (const name of ["admin","content","writer","unscoped","otherOwner"]) {
      assert.equal((await p.list("bookings",actors[name],{page:1,pageSize:1})).total,0,name);
      await assert.rejects(() => p.booking(actors[name],bookingA),denied);
    }
    await assert.rejects(() => p.booking(actors.manager,bookingB),denied);
    await assert.rejects(() => p.booking(actors.booker,unassignedA),denied);
    await assert.rejects(() => p.booking(actors.booker,bookingB),denied);
    await p.read("INSERT INTO app.booking_staff_assignments(provider_id,booking_id,user_id) VALUES($1,$2,$3)",[org.id,bookingB,actors.booker.id]);
    await assert.rejects(() => p.booking(actors.booker,bookingB),denied); // Assignment alone never grants another branch.
    await assert.rejects(() => p.act(actors.manager,randomUUID(),bookingB,{action:"accept",version:1}),denied);
    await assert.rejects(() => p.act(actors.booker,randomUUID(),unassignedA,{action:"accept",version:1}),denied);
    for (const name of ["manager","writer"]) {
      assert.equal((await p.list("managed-activities",actors[name],{page:1,pageSize:1})).total,1);
      await assert.rejects(() => p.createActivity(actors[name],{...draft,branchId:branchB,published:false}),denied);
      await assert.rejects(() => p.correction(actors[name],activityB.id,"Synthetic unauthorized correction"),denied);
    }
    await p.createActivity(actors.writer,{...draft,published:false});
    await assert.rejects(() => p.publishActivity(actors.writer,activityA.id,true),denied);
    await assert.rejects(() => p.createActivity(actors.admin,draft),denied);
    await assert.rejects(() => p.saveContent(actors.support,"about",{title:"Synthetic",body:"Synthetic",version:0,published:false}),denied);
    const ticket = await p.createSupport(actors.parent,"Synthetic support","Synthetic support request");
    assert.equal((await p.support(actors.admin,{page:1,pageSize:20})).total,0);
    await assert.rejects(() => p.replySupport(actors.admin,ticket.id,"resolved","Denied"),denied);
    await p.replySupport(actors.support,ticket.id,"resolved","Synthetic response");

    const acceptKey = randomUUID();
    await p.act(actors.booker,acceptKey,bookingA,{action:"accept",version:1});
    await p.act(actors.parent,randomUUID(),bookingA,{action:"proof",version:2,reference:"SYNTHETIC-NO-FUNDS"});
    for (const name of ["admin","owner","manager","booker","support","content"]) {
      await assert.rejects(() => p.act(actors[name],randomUUID(),bookingA,{action:"verify",version:3}),denied,name);
      await assert.rejects(() => p.completeRefund(actors[name],randomUUID(),"Synthetic reference"),denied,name);
    }
    assert.equal((await p.booking(actors.manager,bookingA)).payments,null);
    assert.equal((await p.booking(actors.support,bookingA)).payments,null);
    assert.equal((await p.booking(actors.finance,bookingA)).payments[0].reference,"SYNTHETIC-NO-FUNDS");
    await assert.rejects(() => p.act({...actors.finance,assuranceLevel:"aal1"},randomUUID(),bookingA,{action:"verify",version:3}),/Step-up/);
    await assert.rejects(() => p.setMember({...actors.owner,assuranceLevel:"aal1"},org.id,actors.booker.id,false),/Step-up/);
    await assert.rejects(() => p.act(actors.support,randomUUID(),unassignedA,{action:"decline",version:1}),/reason/);
    assert.equal((await p.booking(actors.parent,bookingA)).state,"PAYMENT_CHECKING");
    assert.equal((await p.operations(actors.admin)).counts.open_requests,0);
    assert.equal((await p.read("SELECT status FROM app.payments WHERE booking_id=$1",[bookingA]))[0].status,"submitted");

    server = createApp("http://localhost:3000",p,async token => {
      const actor = actors[token];
      if (!actor) throw Object.assign(new Error("Synthetic invalid token"),{status:401});
      return {id:actor.id,email:"synthetic@example.invalid",assuranceLevel:token === "finance" ? "aal1" : actor.assuranceLevel};
    }).listen(0,"127.0.0.1");
    await once(server,"listening");
    const url = `http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
    const branchesUrl = `${url}/providers/${org.id}/branches`;
    const branchesResponse = await fetch(`${branchesUrl}?pageSize=1`,{headers:{Authorization:"Bearer owner"}});
    assert.equal(branchesResponse.status,200);
    assert.equal((await branchesResponse.json()).total,2);
    const deniedBranch = await fetch(branchesUrl,{method:"POST",headers:{Authorization:"Bearer admin","Content-Type":"application/json"},body:JSON.stringify({name:"Unauthorized branch"})});
    assert.equal(deniedBranch.status,404);
    const createdBranch = await fetch(branchesUrl,{method:"POST",headers:{Authorization:"Bearer owner","Content-Type":"application/json"},body:JSON.stringify({name:"Synthetic third branch"})});
    assert.equal(createdBranch.status,201);
    assert.equal((await createdBranch.json()).name,"Synthetic third branch");
    const roleUrl = `${url}/providers/${org.id}/branches/${org.id}/roles`;
    const roleBody = JSON.stringify({userId:actors.unscoped.id,role:"content_staff",active:true});
    for (const name of ["admin","manager","otherOwner"]) {
      const response = await fetch(roleUrl,{method:"PUT",headers:{Authorization:`Bearer ${name}`,"Content-Type":"application/json"},body:roleBody});
      assert.equal(response.status,404,name);
    }
    const roleResponse = await fetch(roleUrl,{method:"PUT",headers:{Authorization:"Bearer owner","Content-Type":"application/json"},body:roleBody});
    assert.equal(roleResponse.status,200);
    assert.equal((await roleResponse.json()).active,true);
    const listedRoles = await fetch(`${roleUrl}?pageSize=2`,{headers:{Authorization:"Bearer owner"}});
    assert.equal(listedRoles.status,200);
    assert.equal((await listedRoles.json()).total,4);
    const assignResponse = await fetch(`${url}/providers/${org.id}/bookings/${unassignedA}/assignments`,{method:"PUT",headers:{Authorization:"Bearer owner","Content-Type":"application/json"},body:JSON.stringify({userId:actors.booker.id,assigned:true})});
    assert.equal(assignResponse.status,200);
    const listedAssignments = await fetch(`${url}/providers/${org.id}/bookings/${unassignedA}/assignments`,{headers:{Authorization:"Bearer owner"}});
    assert.equal((await listedAssignments.json()).total,1);
    assert.equal((await p.list("bookings",actors.booker,{page:1,pageSize:20})).total,2);
    await p.setBookingAssignment(actors.owner,org.id,unassignedA,actors.booker.id,false);
    await p.setBranchRole(actors.owner,org.id,org.id,actors.booker.id,"booking_staff",false);
    await p.setBookingAssignment(actors.owner,org.id,bookingA,actors.booker.id,false);
    await p.setBranchRole(actors.owner,org.id,org.id,actors.booker.id,"booking_staff",true);
    await p.setBookingAssignment(actors.owner,org.id,bookingA,actors.booker.id,true);
    for (const name of ["admin","owner","support","finance"]) {
      const response = await fetch(`${url}/bookings/${bookingA}/actions`,{method:"POST",headers:{Authorization:`Bearer ${name}`,"Content-Type":"application/json","Idempotency-Key":randomUUID(),"X-Assurance-Level":"aal2"},body:JSON.stringify({action:"verify",version:3})});
      assert.ok([403,404].includes(response.status),name);
    }
    assert.equal((await fetch(`${url}/bookings/${bookingB}`,{headers:{Authorization:"Bearer manager"}})).status,404);
    const page = await (await fetch(`${url}/bookings`,{headers:{Authorization:"Bearer booker"}})).json();
    assert.equal(page.total,1);

    const verifyKey = randomUUID();
    await p.act(actors.finance,verifyKey,bookingA,{action:"verify",version:3});
    assert.equal((await p.booking(actors.parent,bookingA)).state,"CONFIRMED");
    const confirmedRoster = (await p.booking(actors.manager,bookingA)).snapshot.children;
    assert.equal(confirmedRoster[0].firstName,"Synthetic");
    assert.equal(confirmedRoster[0].age,12);
    assert.equal(confirmedRoster[0].id,undefined);
    assert.deepEqual((await p.booking(actors.finance,bookingA)).snapshot.children,[]);
    const audit = (await p.read("SELECT details FROM app.audit WHERE subject_id=$1 AND action='verify'",[bookingA]))[0];
    assert.equal(audit.details.capability,"payments.verify");
    await p.read("UPDATE app.platform_role_grants SET active=false WHERE user_id=$1",[actors.finance.id]);
    await assert.rejects(() => p.act(actors.finance,verifyKey,bookingA,{action:"verify",version:3}),denied);
    await p.read("DELETE FROM app.booking_staff_assignments WHERE booking_id=$1 AND user_id=$2",[bookingA,actors.booker.id]);
    await assert.rejects(() => p.act(actors.booker,acceptKey,bookingA,{action:"accept",version:1}),denied);
    assert.equal((await feed.list(actors.booker)).total,0);
    assert.ok((await feed.list(actors.manager)).items.every(row => row.subject_id !== bookingB));
    assert.equal((await feed.list(actors.admin)).items.some(row => bookingIds.includes(row.subject_id)),false);
    await p.setMember(actors.owner,org.id,actors.manager.id,false);
    assert.equal((await p.list("bookings",actors.manager,{page:1,pageSize:20})).total,0);
    assert.equal((await feed.list(actors.manager)).total,0);
    assert.ok((await p.read("SELECT id FROM app.audit WHERE action='permission.update' AND subject_id=$1",[actors.finance.id])).length > 0);
    await p.read("UPDATE app.providers SET status='suspended' WHERE id=$1",[org.id]);
    assert.equal((await p.list("bookings",actors.owner,{page:1,pageSize:20})).total,0);

    // Composite constraints reject cross-provider branch and request assignments.
    await assert.rejects(() => p.read("INSERT INTO app.provider_branch_roles(provider_id,branch_id,user_id,role) VALUES($1,$2,$3,'branch_manager')",[org.id,otherOrg.id,actors.unscoped.id]));
    await assert.rejects(() => p.read("INSERT INTO app.booking_staff_assignments(provider_id,booking_id,user_id) VALUES($1,$2,$3)",[otherOrg.id,bookingA,actors.otherOwner.id]));
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await pg.close();
  }
});
