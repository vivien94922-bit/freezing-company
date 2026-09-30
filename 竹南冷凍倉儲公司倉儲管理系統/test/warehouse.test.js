const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zhunan-warehouse-'));
process.env.DB_PATH = path.join(temp, 'test.sqlite');
const { server, db, inventory, getInventoryOverview } = require('../server');
let base;
before(async () => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

async function request(route, method='GET', data) {
  const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { status: response.status, body: await response.json() };
}

test('seeds separate warehouse stock and reports the combined location totals', async () => {
  const initial=inventory();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM warehouses').get().n,2);
  assert.equal(initial.filter(x=>x.warehouse_id==='W01'&&x.product_id==='P002').length,2);
  assert.deepEqual(initial.filter(x=>x.warehouse_id==='W01'&&x.product_id==='P002').map(x=>x.location),['A02','A05']);
  assert.equal(initial.find(x=>x.warehouse_id==='W02'&&x.product_id==='P004').quantity,6);
  const overview=getInventoryOverview();
  assert.deepEqual(overview.warehouses.map(w=>w.quantity),[21,15]);
  assert.equal(overview.totalQuantity,36);
  assert.equal(overview.warehouses[0].items.find(x=>x.product==='甘藍菜'&&x.location==='A01').quantity,5);
  const apiOverview=await request('/api/inventory/overview');
  assert.equal(apiOverview.status,200);
  assert.equal(apiOverview.body.totalQuantity,36);
  const capacity=await request('/api/storage-capacity');
  assert.equal(capacity.status,200);
  assert.equal(capacity.body.find(x=>x.warehouse_id==='W01'&&x.product_id==='P002').available_capacity,32);
  assert.equal(capacity.body.find(x=>x.warehouse_id==='W02'&&x.product_id==='P002').available_capacity,15);
  assert.equal(capacity.body.find(x=>x.warehouse_id==='W01'&&x.product_id==='P002').location_count,2);
  assert.equal(capacity.body.find(x=>x.warehouse_id==='W02'&&x.product_id==='P002').location_count,1);
});

test('inbound requires a location and persists a new timestamped batch and transaction', async () => {
  const receivedAt='2026-09-29T02:15:00.000Z';
  assert.equal((await request('/api/inbounds','POST',{warehouse:'W01',product:'P001',quantity:2,location:' ',receivedAt})).status,400);
  assert.equal((await request('/api/inbounds','POST',{warehouse:'W01',product:'P001',quantity:2,location:'A01',receivedAt:'not-a-date'})).status,400);
  assert.equal((await request('/api/inbounds','POST',{warehouse:'W01',product:'P001',quantity:2,location:'A02',receivedAt})).status,400);
  const a01=(await request('/api/locations')).body.find(x=>x.warehouse_id==='W01'&&x.code==='A01');
  assert.equal((await request(`/api/locations/${a01.id}`,'PATCH',{capacity:4})).status,409);
  assert.equal((await request(`/api/locations/${a01.id}`,'PATCH',{capacity:7})).status,200);
  const before=inventory().filter(x=>x.warehouse_id==='W01'&&x.product_id==='P001').reduce((s,x)=>s+x.quantity,0);
  const result=await request('/api/inbounds','POST',{warehouse:'W01',product:'P001',quantity:2,location:'A01',receivedAt});
  assert.equal(result.status,201);assert.match(result.body.batchId,/^B\d{17}$/);assert.ok(result.body.receivedAt);
  assert.equal(result.body.receivedAt,receivedAt);
  assert.equal(inventory().filter(x=>x.warehouse_id==='W01'&&x.product_id==='P001').reduce((s,x)=>s+x.quantity,0),before+2);
  assert.equal(inventory().find(x=>x.batch_id===result.body.batchId).is_latest_inbound,1);
  assert.equal(inventory().filter(x=>x.warehouse_id==='W01'&&x.product_id==='P001'&&x.is_latest_inbound).length,1);
  const logged=db.prepare("SELECT COUNT(*) n FROM transactions WHERE type='inbound' AND batch_id=? AND reason='新進貨'").get(result.body.batchId).n;
  assert.equal(logged,1);
  const fullLocation=(await request('/api/locations?warehouse=W01&product=P001')).body.find(x=>x.code==='A01');
  assert.equal(fullLocation.quantity,7);assert.equal(fullLocation.capacity,7);
  const full=await request('/api/inbounds','POST',{warehouse:'W01',product:'P001',quantity:1,location:'A01',receivedAt});
  assert.equal(full.status,409);assert.match(full.body.error,/庫存已滿/);
});

test('deleting an inbound removes its stock and hides it while logging the reversal', async () => {
  const batch=db.prepare("SELECT b.id,b.quantity FROM batches b JOIN transactions t ON t.batch_id=b.id WHERE t.type='inbound' AND t.reason='新進貨' ORDER BY t.id DESC LIMIT 1").get();
  const result=await request(`/api/inbounds/${batch.id}`,'DELETE');
  assert.equal(result.status,200);assert.equal(result.body.removedQuantity,2);
  assert.equal(inventory().some(x=>x.batch_id===batch.id),false);
  assert.ok(db.prepare("SELECT 1 FROM transactions WHERE batch_id=? AND type='inbound' AND voided_at IS NOT NULL").get(batch.id));
  assert.equal(db.prepare("SELECT reason FROM transactions WHERE batch_id=? AND type='stocktake'").get(batch.id).reason,`撤銷誤登進貨 ${batch.id}`);
  const history=await request('/api/transactions');
  assert.equal(history.body.some(row=>row.batch_id===batch.id&&row.type==='inbound'),false);
  assert.ok(history.body.some(row=>row.batch_id===batch.id&&row.type==='stocktake'));
});

test('location choices are restricted to the selected warehouse and product', async () => {
  const w1=await request('/api/locations?warehouse=W01&product=P001');
  const w2=await request('/api/locations?warehouse=W02&product=P001');
  const greens=await request('/api/locations?warehouse=W01&product=P002');
  assert.deepEqual(w1.body.map(x=>x.code),['A01']);
  assert.deepEqual(w2.body.map(x=>x.code),['B01']);
  assert.deepEqual(greens.body.map(x=>x.code),['A02','A05']);
});

test('outbound consumes FIFO across batches and rejects insufficient stock without partial writes', async () => {
  const plan=[{batchId:'B20260925001',quantity:3},{batchId:'B20260926001',quantity:1}];
  assert.equal((await request('/api/outbounds','POST',{product:'P002',quantity:4})).status,409);
  const sheet=await request('/api/transfer-sheets','POST',{product:'P002',quantity:4});
  assert.equal(sheet.status,201);assert.equal(sheet.body.status,'open');assert.equal(sheet.body.lines.length,2);
  assert.deepEqual(sheet.body.lines.map(line=>[line.warehouse_id,line.location,line.quantity]),[['W01','A02',3],['W02','B02',1]]);
  assert.ok(sheet.body.lines[0].receivedAt<sheet.body.lines[1].receivedAt);
  const unchecked=await request('/api/outbounds','POST',{product:'P002',quantity:4,transferSheetId:sheet.body.id,pickedBatches:plan});
  assert.equal(unchecked.status,409);assert.equal(unchecked.body.error,'搬運單尚未完成勾選');
  const wrong=await request(`/api/transfer-sheets/${sheet.body.id}/complete`,'POST',{completed:true,pickedBatches:[{batchId:'B20260926001',quantity:3},{batchId:'B20260925001',quantity:1}]});
  assert.equal(wrong.status,409);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM transactions WHERE type='outbound'").get().n,0);
  const completed=await request(`/api/transfer-sheets/${sheet.body.id}/complete`,'POST',{completed:true,pickedBatches:plan});
  assert.equal(completed.status,200);assert.equal(completed.body.status,'completed');
  const result=await request('/api/outbounds','POST',{product:'P002',quantity:4,transferSheetId:sheet.body.id,pickedBatches:plan});
  assert.equal(result.status,201);
  assert.equal(result.body.transferSheetId,sheet.body.id);
  assert.equal(db.prepare('SELECT status FROM transfer_sheets WHERE id=?').get(sheet.body.id).status,'shipped');
  assert.deepEqual(result.body.picks.map(x=>[x.warehouse_id,x.location,x.quantity]),[['W01','A02',3],['W02','B02',1]]);
  assert.deepEqual(inventory().filter(x=>x.product_id==='P002').map(x=>[x.warehouse_id,x.location,x.quantity]),[['W01','A05',5],['W02','B02',4]]);
  const count=db.prepare("SELECT COUNT(*) n FROM transactions WHERE type='outbound'").get().n;
  const failed=await request('/api/transfer-sheets','POST',{product:'P002',quantity:10});
  assert.equal(failed.status,409);assert.equal(failed.body.available,9);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM transactions WHERE type='outbound'").get().n,count);
  assert.equal(inventory().filter(x=>x.product_id==='P002').reduce((sum,x)=>sum+x.quantity,0),9);
  const usedBatch=result.body.picks.at(-1).batchId;
  assert.equal(inventory().find(x=>x.batch_id===usedBatch).can_delete,1);
  const removed=await request(`/api/inbounds/${usedBatch}`,'DELETE');
  assert.equal(removed.status,200);assert.equal(removed.body.removedQuantity,4);
  assert.equal(inventory().some(x=>x.product_id==='P002'&&x.warehouse_id==='W02'),false);
  assert.equal(inventory().find(x=>x.product_id==='P002'&&x.warehouse_id==='W01').quantity,5);
  assert.ok(db.prepare("SELECT 1 FROM transactions WHERE batch_id=? AND type='outbound' AND voided_at IS NULL").get(usedBatch));
});

test('scrap needs a reason and cannot reduce a batch below zero', async () => {
  const batch=inventory().find(x=>x.warehouse_id==='W01'&&x.product_id==='P001');
  assert.equal((await request('/api/scraps','POST',{warehouse:'W01',product:'P001',batchId:batch.batch_id,quantity:1,reason:''})).status,400);
  assert.equal((await request('/api/scraps','POST',{warehouse:'W01',product:'P001',batchId:batch.batch_id,quantity:99,reason:'腐爛'})).status,409);
  const result=await request('/api/scraps','POST',{warehouse:'W01',product:'P001',batchId:batch.batch_id,quantity:1,reason:'腐爛'});
  assert.equal(result.status,201);assert.equal(result.body.remaining,batch.quantity-1);
  assert.equal(db.prepare("SELECT reason FROM transactions WHERE type='scrap'").get().reason,'腐爛');
  assert.equal((await request('/api/scraps','POST',{warehouse:'W01',product:'P001',batchId:batch.batch_id,quantity:1,reasonCategory:'其他',reason:'其他',reasonOther:''})).status,400);
  const custom=await request('/api/scraps','POST',{warehouse:'W01',product:'P001',batchId:batch.batch_id,quantity:1,reasonCategory:'其他',reason:'冷凍灼傷',reasonOther:'冷凍灼傷'});
  assert.equal(custom.status,201);
  assert.equal(db.prepare("SELECT reason FROM transactions WHERE type='scrap' ORDER BY id DESC LIMIT 1").get().reason,'冷凍灼傷');
});

test('stocktake captures system quantity and records an adjustment when confirmed', async () => {
  const opened=await request('/api/stocktakes','POST',{warehouse:'W02'});
  assert.equal(opened.status,201);assert.ok(opened.body.lines.length);
  const line=opened.body.lines.find(x=>x.product==='玉米');assert.equal(line.system_quantity,6);
  const confirmed=await request(`/api/stocktakes/${opened.body.id}/confirm`,'POST',{actual:{[line.batch_id]:5}});
  assert.equal(confirmed.status,200);assert.equal(confirmed.body.adjustments,1);
  assert.equal(inventory().find(x=>x.batch_id===line.batch_id).quantity,5);
  assert.equal(db.prepare("SELECT quantity,reason FROM transactions WHERE type='stocktake' AND batch_id=?").get(line.batch_id).quantity,1);
});

test('serves the app as HTML and supports validated warehouse, product and location setup', async () => {
  const page=await fetch(base+'/');assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/text\/html/);
  const app=await (await fetch(base+'/app.js')).text();
  assert.match(app,/type="datetime-local" name="receivedAt"/);
  assert.match(app,/function receiptOrder\(/);
  assert.match(app,/id="dashboard-product-filter"/);
  assert.match(app,/capacity-callout/);
  assert.match(app,/還可存放/);
  assert.match(app,/dashboardProduct/);
  assert.match(app,/目前最早：/);
  assert.match(app,/b\.received_at\.localeCompare\(a\.received_at\)/);
  assert.match(app,/receipt-age-\$\{x\.receiptRank%6\}/);
  assert.match(app,/function receiptNote\(/);
  assert.match(app,/data-delete-inbound/);
  assert.match(app,/class="input pick-scan"/);
  assert.match(app,/id="generate-transfer"/);
  assert.match(app,/id="transfer-completed"/);
  assert.match(app,/transferSheetId/);
  const outboundUi=app.slice(app.indexOf('function outboundPage()'),app.indexOf('function stocktakePage()'));
  assert.doesNotMatch(outboundUi,/出貨倉庫/);
  assert.match(outboundUi,/跨倉搬運單/);
  assert.match(app,/name="reasonCategory"/);
  assert.match(app,/id="scrap-other-field"/);
  assert.equal((await request('/api/warehouses','POST',{id:'W03',name:'測試倉'})).status,201);
  assert.equal((await request('/api/products','POST',{id:'P005',name:'花椰菜',unit:'箱',minStock:2})).status,201);
  assert.equal((await request('/api/locations','POST',{warehouse:'W03',code:'C01',product:'P005',capacity:12})).status,201);
  assert.equal((await request('/api/locations','POST',{warehouse:'W03',code:'C01',product:'P005',capacity:12})).status,409);
  assert.deepEqual((await request('/api/locations?warehouse=W03&product=P005')).body.map(x=>x.code),['C01']);
  const created=(await request('/api/locations?warehouse=W03&product=P005')).body[0];
  assert.equal(created.capacity,12);assert.equal(created.quantity,0);
  assert.equal((await request(`/api/locations/${created.id}`,'PATCH',{capacity:-1})).status,400);
  assert.equal((await request(`/api/locations/${created.id}`,'PATCH',{capacity:''})).status,400);
  assert.equal((await request('/api/locations','POST',{warehouse:'W03',code:'C02'})).status,201);
  assert.equal((await request('/api/locations')).body.find(x=>x.warehouse_id==='W03'&&x.code==='C02').capacity,20);
  assert.equal((await request('/api/warehouses','POST',{id:'bad',name:'錯誤'})).status,400);
});
