/********************************************************************
 * AKSHARDHAM TASKS — Google Apps Script Backend (v4 FAST)
 * Frontend: akshardham-ops-v6.html
 *
 * SETUP:
 *  1. New Google Sheet → Extensions → Apps Script → paste this → Save
 *  2. Run: setupSheets
 *  3. Script Properties (⚙️):
 *       ANTHROPIC_API_KEY = sk-ant-...
 *       WA_PROVIDER = cloud | aisensy | wati | none
 *       (cloud)  WA_PHONE_ID, WA_TOKEN, WA_TEMPLATE=task_reminder, WA_LANG=en_US
 *       (aisensy) WA_API_KEY, WA_CAMPAIGN
 *       (wati)   WA_API_KEY, WA_BASE_URL
 *  4. Deploy → New deployment → Web app → Execute as Me, Anyone
 *     Copy URL → paste in frontend CONFIG.API_URL
 *  5. Run: setupTriggers
 *  6. Run: testReminder (verify WhatsApp/email)
 *
 *  ⚠️ Every code change: Deploy → Manage → Edit → New version → Deploy
 *
 * SPEED OPTIMIZATIONS:
 *  - Batch API: multiple actions in 1 HTTP request
 *  - CacheService: sheet reads cached 45 sec, invalidated on writes
 ********************************************************************/

var SHEETS = {
  USERS:    ['Name','Role','Password','Phone','Email','KRAs'],
  TASKS:    ['TaskID','Date','Name','Role','Task','Type','AssignedBy',
             'Status','Report','NextAction','NextDate','Aligned','Score','MatchedKRA'],
  MIDDAY:   ['Date','Name','Note'],
  FEEDBACK: ['Date','Name','By','Feedback','TaskRef'],
  BUCKET:   ['ID','Task','For','By','Status'],
  KPIDEFS:  ['Name','KRA','Label','Unit','Target'],
  KPILOG:   ['Date','Name','Label','Value']
};

/* ═══════════════════════════════════════════════════════
   WEB APP ENTRY
═══════════════════════════════════════════════════════ */
function doGet() {
  return out({ ok: true, data: 'Akshardham Tasks API v4 FAST ✔' });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var req  = JSON.parse(e.postData.contents);
    var a    = req.action;
    var data;

    if      (a === 'batch')        data = batchHandle(req);
    else if (a === 'login')        data = login(req);
    else if (a === 'myday')        data = myday(req);
    else if (a === 'addtask')      data = addtask(req);
    else if (a === 'assign')       data = assign(req);
    else if (a === 'toggle')       data = toggleTask(req);
    else if (a === 'eod')          data = eod(req);
    else if (a === 'midday')       data = middaySave(req);
    else if (a === 'align')        data = align(req);
    else if (a === 'feedback')     data = feedbackAdd(req);
    else if (a === 'kraGet')       data = kraGet(req);
    else if (a === 'kraSet')       data = kraSet(req);
    else if (a === 'kpiGet')       data = kpiGet(req);
    else if (a === 'kpiSet')       data = kpiSet(req);
    else if (a === 'kpiLog')       data = kpiLogSave(req);
    else if (a === 'kpiLogGet')    data = kpiLogGet(req);
    else if (a === 'myrange')      data = myrange(req);
    else if (a === 'teamrange')    data = teamrange(req);
    else if (a === 'userList')     data = userList();
    else if (a === 'userAdd')      data = userAdd(req);
    else if (a === 'userUpdate')   data = userUpdate(req);
    else if (a === 'bucketList')   data = bucketList();
    else if (a === 'bucketAdd')    data = bucketAdd(req);
    else if (a === 'bucketEdit')   data = bucketEdit(req);
    else if (a === 'bucketDelete') data = bucketDelete(req);
    else if (a === 'bucketAssign') data = bucketAssign(req);
    else throw new Error('Unknown action: ' + a);

    return out({ ok: true, data: data });
  } catch (err) {
    return out({ ok: false, error: String(err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function out(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ═══════════════════════════════════════════════════════
   BATCH — multiple actions in 1 HTTP request (SPEED FIX)
   Frontend sends: { action:'batch', calls:[{action,..},{action,..}] }
   Returns array of results in same order.
═══════════════════════════════════════════════════════ */
function batchHandle(req) {
  var calls = req.calls || [];
  return calls.map(function(c) {
    try {
      var a = c.action;
      if (a === 'myday')      return myday(c);
      if (a === 'myrange')    return myrange(c);
      if (a === 'kpiGet')     return kpiGet(c);
      if (a === 'kpiSet')     return kpiSet(c);
      if (a === 'kpiLog')     return kpiLogSave(c);
      if (a === 'kpiLogGet')  return kpiLogGet(c);
      if (a === 'teamrange')  return teamrange(c);
      if (a === 'kraGet')     return kraGet(c);
      if (a === 'bucketList') return bucketList();
      return { error: 'Unknown batch action: ' + a };
    } catch (e) {
      return { error: String(e.message || e) };
    }
  });
}

/* ═══════════════════════════════════════════════════════
   ACTIONS
═══════════════════════════════════════════════════════ */
function login(d) {
  var u = findUser(d.name);
  if (!u || String(u.Password) !== String(d.password))
    throw new Error('Incorrect name or password');
  return { name: u.Name, role: u.Role, kras: parseKras(u.KRAs) };
}

function myday(d) {
  var today    = d.date;
  var allTasks = readRowsCached('TASKS');

  var todayTasks = allTasks.filter(function(t) {
    return t.Date === today && same(t.Name, d.name);
  });

  // Carry-forward: pending tasks from past whose NextDate = today
  var carried = allTasks.filter(function(t) {
    return same(t.Name, d.name) &&
           t.Date !== today &&
           t.Status !== 'done' &&
           t.NextDate === today &&
           !todayTasks.some(function(tt) { return tt.Task === t.Task; });
  }).map(function(t) {
    return merge(t, { _carried: true, _fromDate: t.Date });
  });

  var fb = readRowsCached('FEEDBACK')
    .filter(function(f) { return same(f.Name, d.name); })
    .slice(-15);

  var midRows = readRowsCached('MIDDAY')
    .filter(function(m) { return m.Date === today && same(m.Name, d.name); });

  return {
    tasks:    todayTasks.concat(carried),
    feedback: fb,
    midday:   midRows.length ? midRows[midRows.length - 1].Note : ''
  };
}

function addtask(d) {
  var t = {
    TaskID: 't' + new Date().getTime() + Math.floor(Math.random() * 999),
    Date: d.date, Name: d.name, Role: d.role || roleOf(d.name),
    Task: d.task, Type: 'listed', AssignedBy: '', Status: 'open',
    Report: '', NextAction: '', NextDate: '', Aligned: '', Score: '', MatchedKRA: ''
  };
  appendRow('TASKS', t);
  invalidateCache('TASKS');
  return t;
}

function assign(d) {
  var t = {
    TaskID: 'a' + new Date().getTime() + Math.floor(Math.random() * 999),
    Date: d.date, Name: d.name, Role: roleOf(d.name),
    Task: d.task, Type: 'assigned', AssignedBy: d.by, Status: 'open',
    Report: '', NextAction: '', NextDate: '', Aligned: '', Score: '', MatchedKRA: ''
  };
  appendRow('TASKS', t);
  invalidateCache('TASKS');
  return t;
}

function toggleTask(d) {
  updateTask(d.taskId, { Status: d.status });
  invalidateCache('TASKS');
  return { ok: 1 };
}

function eod(d) {
  updateTask(d.taskId, {
    Report: d.report, Status: d.status,
    NextAction: d.nextAction || '', NextDate: d.nextDate || ''
  });
  invalidateCache('TASKS');
  return { ok: 1 };
}

function middaySave(d) {
  var rows = readRowsCached('MIDDAY');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].Date === d.date && same(rows[i].Name, d.name)) {
      setCell('MIDDAY', i, 'Note', d.note);
      invalidateCache('MIDDAY');
      return { ok: 1 };
    }
  }
  appendRow('MIDDAY', { Date: d.date, Name: d.name, Note: d.note });
  invalidateCache('MIDDAY');
  return { ok: 1 };
}

function feedbackAdd(d) {
  appendRow('FEEDBACK', {
    Date: d.date, Name: d.name, By: d.by,
    Feedback: d.feedback, TaskRef: d.taskRef || ''
  });
  invalidateCache('FEEDBACK');
  return { ok: 1 };
}

function kraGet(d) {
  var u = findUser(d.name);
  return u ? parseKras(u.KRAs) : [];
}

function kraSet(d) {
  var rows = readRowsCached('USERS');
  for (var i = 0; i < rows.length; i++) {
    if (same(rows[i].Name, d.name)) {
      setCell('USERS', i, 'KRAs', (d.kras || []).join(' | '));
      invalidateCache('USERS');
      return { ok: 1 };
    }
  }
  throw new Error('User not found: ' + d.name);
}

function kpiGet(d) {
  return readRowsCached('KPIDEFS')
    .filter(function(r) { return same(r.Name, d.name); })
    .map(function(r) {
      return { kra: r.KRA, label: r.Label, unit: r.Unit, target: +r.Target || 0 };
    });
}

function kpiSet(d) {
  var sh   = sheet('KPIDEFS');
  var rows = readRowsCached('KPIDEFS');
  // Delete existing rows for this user (bottom-up to keep indices)
  var idxs = [];
  rows.forEach(function(r, i) { if (same(r.Name, d.name)) idxs.push(i + 2); });
  idxs.reverse().forEach(function(n) { sh.deleteRow(n); });
  // Insert new
  (d.kpis || []).forEach(function(k) {
    appendRow('KPIDEFS', {
      Name: d.name, KRA: k.kra, Label: k.label,
      Unit: k.unit || 'count', Target: k.target || 0
    });
  });
  invalidateCache('KPIDEFS');
  return { ok: 1 };
}

function kpiLogSave(d) {
  var rows = readRowsCached('KPILOG');
  Object.keys(d.values || {}).forEach(function(label) {
    var val   = d.values[label];
    var found = false;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].Date === d.date && same(rows[i].Name, d.name) && rows[i].Label === label) {
        setCell('KPILOG', i, 'Value', val);
        found = true;
        break;
      }
    }
    if (!found) appendRow('KPILOG', { Date: d.date, Name: d.name, Label: label, Value: val });
  });
  invalidateCache('KPILOG');
  return { ok: 1 };
}

function kpiLogGet(d) {
  var days = d.days || 7;
  var name = d.name;
  var all  = readRowsCached('KPILOG');
  var result = [];
  for (var i = 0; i < days; i++) {
    var date   = dateOffset(-i);
    var values = {};
    all.filter(function(r) { return r.Date === date && same(r.Name, name); })
       .forEach(function(r) { values[r.Label] = +r.Value || 0; });
    result.push({ date: date, values: values });
  }
  return result;
}

function myrange(d) {
  return {
    tasks: readRowsCached('TASKS').filter(function(t) {
      return same(t.Name, d.name) && t.Date >= d.from && t.Date <= d.to;
    })
  };
}

function teamrange(d) {
  return {
    users: readRowsCached('USERS').map(function(u) { return { name: u.Name, role: u.Role }; }),
    tasks: readRowsCached('TASKS').filter(function(t) { return t.Date >= d.from && t.Date <= d.to; })
  };
}

function userList() {
  return readRowsCached('USERS').map(function(u) {
    return { name: u.Name, role: u.Role, phone: String(u.Phone || '') };
  });
}

function userAdd(d) {
  if (findUser(d.name)) throw new Error('Member already exists: ' + d.name);
  appendRow('USERS', {
    Name: d.name, Role: d.role, Password: d.password,
    Phone: d.phone || '', Email: d.email || '', KRAs: ''
  });
  invalidateCache('USERS');
  return { ok: 1 };
}

function userUpdate(d) {
  var rows = readRowsCached('USERS');
  for (var i = 0; i < rows.length; i++) {
    if (same(rows[i].Name, d.name)) {
      if (d.role)                          setCell('USERS', i, 'Role',     d.role);
      if (d.phone !== undefined && d.phone) setCell('USERS', i, 'Phone',    d.phone);
      if (d.email)                          setCell('USERS', i, 'Email',    d.email);
      if (d.password)                       setCell('USERS', i, 'Password', d.password);
      invalidateCache('USERS');
      return { ok: 1 };
    }
  }
  throw new Error('Member not found: ' + d.name);
}

function bucketList() {
  return readRowsCached('BUCKET')
    .filter(function(b) { return b.Status !== 'assigned'; })
    .map(function(b) { return { id: b.ID, Task: b.Task, For: b.For, By: b.By }; });
}

function bucketAdd(d) {
  appendRow('BUCKET', {
    ID: 'b' + new Date().getTime(), Task: d.task,
    For: d['for'], By: d.by, Status: 'bucket'
  });
  invalidateCache('BUCKET');
  return { ok: 1 };
}

function bucketEdit(d) {
  var rows = readRowsCached('BUCKET');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].ID) === String(d.id)) {
      setCell('BUCKET', i, 'Task', d.task);
      invalidateCache('BUCKET');
      return { ok: 1 };
    }
  }
  throw new Error('Bucket item not found');
}

function bucketDelete(d) {
  var sh   = sheet('BUCKET');
  var rows = readRowsCached('BUCKET');
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i].ID) === String(d.id)) {
      sh.deleteRow(i + 2);
      invalidateCache('BUCKET');
      return { ok: 1 };
    }
  }
  throw new Error('Bucket item not found');
}

function bucketAssign(d) {
  var rows = readRowsCached('BUCKET');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].ID) === String(d.id)) {
      setCell('BUCKET', i, 'Status', 'assigned');
      assign({ name: rows[i].For, task: rows[i].Task, by: d.by, date: d.date });
      invalidateCache('BUCKET');
      return { ok: 1 };
    }
  }
  throw new Error('Bucket item not found');
}

/* ═══════════════════════════════════════════════════════
   AI ALIGNMENT
═══════════════════════════════════════════════════════ */
function align(d) {
  var u    = findUser(d.name);
  var kras = u ? parseKras(u.KRAs) : [];
  var key  = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  var r;
  if (key) {
    try { r = claudeAlign(key, d.task, kras, u ? u.Role : ''); }
    catch (err) { r = keywordAlign(d.task, kras); }
  } else {
    r = keywordAlign(d.task, kras);
  }
  updateTask(d.taskId, { Aligned: r.aligned ? 'YES' : 'NO', Score: r.score, MatchedKRA: r.kra || '' });
  invalidateCache('TASKS');
  return r;
}

function claudeAlign(key, task, kras, role) {
  var sys = 'You are a task-KRA alignment checker for Akshardham Associates (real-estate colony developer). ' +
    'Given a task and KRA list, decide alignment. Vague busywork (arranging desk, scrolling pages) = low score. ' +
    'Respond ONLY in JSON: {"aligned":true/false,"score":1-5,"kra":"matching KRA or empty","reason":"1 line","suggestion":"1 line or empty"}';
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: 'claude-haiku-4-5', max_tokens: 300, system: sys,
      messages: [{ role: 'user', content: 'Role: ' + role + '\nKRAs:\n- ' + kras.join('\n- ') + '\n\nTask: "' + task + '"' }]
    }),
    muteHttpExceptions: true
  });
  var body = JSON.parse(res.getContentText());
  if (res.getResponseCode() !== 200) throw new Error(body.error ? body.error.message : 'API error');
  var txt = body.content.map(function(c) { return c.text || ''; }).join('').replace(/```json|```/g, '').trim();
  var j = JSON.parse(txt);
  return { aligned: !!j.aligned, score: Number(j.score) || 1, kra: j.kra || '', reason: j.reason || '', suggestion: j.suggestion || '' };
}

function keywordAlign(task, kras) {
  var t    = String(task).toLowerCase();
  var hits = ['call','lead','visit','site','book','customer','follow','post','reel','ad',
               'collection','payment','meeting','target','review','sale','plot','colony',
               'whatsapp','convert','receipt','registry','crm','scheme','layout','training','agent'];
  var n = hits.filter(function(h) { return t.indexOf(h) >= 0; }).length;
  if (n >= 2) return { aligned: true,  score: 5, kra: kras[0] || '', reason: 'Core work aligned',        suggestion: '' };
  if (n === 1) return { aligned: true,  score: 3, kra: kras[0] || '', reason: 'Partially aligned',        suggestion: 'Add measurable target' };
  return         { aligned: false, score: 1, kra: '',           reason: 'Not linked to any KRA', suggestion: 'Pick a core KRA task' };
}

/* ═══════════════════════════════════════════════════════
   REMINDERS — WhatsApp / Email
   Script Properties:
     OPTION A (Meta Cloud API — cheapest):
       WA_PROVIDER = cloud
       WA_PHONE_ID = <Phone Number ID from Meta dashboard>
       WA_TOKEN    = <Permanent system user token>
       WA_TEMPLATE = task_reminder   ← template body must have {{1}}
       WA_LANG     = en_US
     OPTION B (AiSensy):
       WA_PROVIDER  = aisensy
       WA_API_KEY   = <key>
       WA_CAMPAIGN  = <campaign name>  ← campaign body must have {{1}}
     OPTION C (WATI):
       WA_PROVIDER  = wati
       WA_API_KEY   = <Bearer token>
       WA_BASE_URL  = https://live-server-XXXX.wati.io
     No WhatsApp → leave WA_PROVIDER blank → email fallback
       (fill Email column in Users sheet)
═══════════════════════════════════════════════════════ */
function setupTriggers() {
  var names = ['reminder11','reminder14','reminder1730','dailySnapshot','weeklyAiReport'];
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (names.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('reminder11')      .timeBased().everyDays(1).atHour(11).create();
  ScriptApp.newTrigger('reminder14')      .timeBased().everyDays(1).atHour(14).create();
  ScriptApp.newTrigger('reminder1730')    .timeBased().everyDays(1).atHour(17).nearMinute(30).create();
  ScriptApp.newTrigger('dailySnapshot')   .timeBased().everyDays(1).atHour(18).create();
  ScriptApp.newTrigger('weeklyAiReport')  .timeBased().onWeekDay(ScriptApp.WeekDay.FRIDAY).atHour(18).create();
  Logger.log('Triggers set: 11:00 / 14:00 / 17:30 / 18:00 snapshot / Friday 18:00 AI report ✔');
}

function reminder11() {
  var today = todayStr();
  eachEmployee(function(u) {
    var has = readRowsCached('TASKS').some(function(t) { return t.Date === today && same(t.Name, u.Name); });
    if (!has) sendReminder(u, '⏰ Hello ' + u.Name + '! It\'s past 11 AM — please add today\'s 3-5 tasks in the app. — Akshardham Tasks');
  });
}

function reminder14() {
  var today = todayStr();
  eachEmployee(function(u) {
    var has = readRowsCached('MIDDAY').some(function(m) { return m.Date === today && same(m.Name, u.Name) && m.Note; });
    if (!has) sendReminder(u, '🕑 ' + u.Name + ', it\'s past 2 PM — please file your mid-day update. — Akshardham Tasks');
  });
}

function reminder1730() {
  var today = todayStr();
  eachEmployee(function(u) {
    var pending = readRowsCached('TASKS').filter(function(t) { return t.Date === today && same(t.Name, u.Name) && !t.Report; });
    if (pending.length) sendReminder(u, '🌙 ' + u.Name + ', EOD time! ' + pending.length + ' task(s) still need a report. — Akshardham Tasks');
  });
}

function eachEmployee(fn) {
  readRowsCached('USERS').forEach(function(u) { if (!/admin/i.test(u.Role)) fn(u); });
}

function testReminder() {
  var me = findUser('Krishan') || readRowsCached('USERS')[0];
  if (!me) { Logger.log('No users found — run setupSheets first'); return; }
  sendReminder(me, '✅ Test from Akshardham Tasks — WhatsApp/email working!');
  Logger.log('Test sent to ' + me.Name + ' (' + (me.Phone || 'no phone') + ' / ' + (me.Email || 'no email') + ')');
}

function sendReminder(user, msg) {
  var p     = PropertiesService.getScriptProperties();
  var prov  = (p.getProperty('WA_PROVIDER') || 'none').toLowerCase();
  var raw   = String(user.Phone || '').replace(/\D/g, '');
  var phone = raw.length >= 10 ? raw.slice(-10) : '';
  try {
    if (prov === 'cloud' && phone) {
      var r = UrlFetchApp.fetch(
        'https://graph.facebook.com/v20.0/' + p.getProperty('WA_PHONE_ID') + '/messages',
        {
          method: 'post', contentType: 'application/json',
          headers: { Authorization: 'Bearer ' + p.getProperty('WA_TOKEN') },
          payload: JSON.stringify({
            messaging_product: 'whatsapp', to: '91' + phone, type: 'template',
            template: {
              name: p.getProperty('WA_TEMPLATE') || 'task_reminder',
              language: { code: p.getProperty('WA_LANG') || 'en_US' },
              components: [{ type: 'body', parameters: [{ type: 'text', text: msg }] }]
            }
          }),
          muteHttpExceptions: true
        }
      );
      Logger.log('WhatsApp Cloud → ' + user.Name + ' status ' + r.getResponseCode());
      return;
    }
    if (prov === 'aisensy' && phone) {
      UrlFetchApp.fetch('https://backend.aisensy.com/campaign/t1/api/v2', {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify({
          apiKey: p.getProperty('WA_API_KEY'), campaignName: p.getProperty('WA_CAMPAIGN'),
          destination: '91' + phone, userName: user.Name, templateParams: [msg]
        }),
        muteHttpExceptions: true
      });
      Logger.log('AiSensy → ' + user.Name);
      return;
    }
    if (prov === 'wati' && phone) {
      UrlFetchApp.fetch(
        p.getProperty('WA_BASE_URL') + '/api/v1/sendSessionMessage/91' + phone + '?messageText=' + encodeURIComponent(msg),
        { method: 'post', headers: { Authorization: 'Bearer ' + p.getProperty('WA_API_KEY') }, muteHttpExceptions: true }
      );
      Logger.log('WATI → ' + user.Name);
      return;
    }
    var email = String(user.Email || '').trim();
    if (email) {
      MailApp.sendEmail({ to: email, subject: 'Akshardham Tasks — Reminder', body: msg + '\n\nAutomated — Akshardham Tasks' });
      Logger.log('Email → ' + user.Name + ' (' + email + ')');
    } else {
      Logger.log('No phone/email for ' + user.Name + ' — skipped');
    }
  } catch (err) {
    Logger.log('sendReminder ERROR ' + user.Name + ': ' + String(err));
  }
}

/* ═══════════════════════════════════════════════════════
   DAILY SNAPSHOT EMAIL — 6 PM to admin
═══════════════════════════════════════════════════════ */
function dailySnapshot() {
  var today = todayStr();
  var tasks = readRowsCached('TASKS').filter(function(t) { return t.Date === today; });
  var users = readRowsCached('USERS');
  var admin = users.filter(function(u) { return /admin/i.test(u.Role); })[0];
  if (!admin || !admin.Email) { Logger.log('No admin email — fill Email in Users sheet'); return; }

  var filed = [], notFiled = [], highlights = [];
  users.filter(function(u) { return !/admin/i.test(u.Role); }).forEach(function(u) {
    var ut       = tasks.filter(function(t) { return same(t.Name, u.Name); });
    var hasReport = ut.some(function(t) { return t.Report; });
    if (ut.length && hasReport) filed.push(u.Name + ' (' + ut.length + ' tasks)');
    else notFiled.push(u.Name + (ut.length ? '' : ' — no entry today'));
    ut.filter(function(t) { return t.Status === 'done' && t.Report; }).slice(0, 2).forEach(function(t) {
      highlights.push('<b>' + u.Name + ':</b> ' + t.Task + ' — ' + t.Report);
    });
  });

  var html = '<h2 style="color:#E06318;font-family:sans-serif">📊 Daily Snapshot — ' + today + '</h2>' +
    '<table style="font-family:sans-serif;font-size:14px"><tr>' +
    '<td valign="top" style="padding-right:30px"><h3 style="color:#15803d">✅ Filed (' + filed.length + ')</h3>' +
    '<ul>' + filed.map(function(x) { return '<li>' + x + '</li>'; }).join('') + '</ul></td>' +
    '<td valign="top"><h3 style="color:#c2460a">⚠️ Missing (' + notFiled.length + ')</h3>' +
    '<ul>' + notFiled.map(function(x) { return '<li>' + x + '</li>'; }).join('') + '</ul></td></tr></table>' +
    (highlights.length ? '<h3 style="font-family:sans-serif">🏆 Highlights</h3><ul style="font-family:sans-serif">' +
      highlights.map(function(x) { return '<li>' + x + '</li>'; }).join('') + '</ul>' : '') +
    '<hr><p style="font-family:sans-serif;color:#888;font-size:12px">Akshardham Tasks — ' + new Date().toLocaleString() + '</p>';

  MailApp.sendEmail({ to: admin.Email, subject: '📊 Daily Snapshot — ' + today, htmlBody: html });
  Logger.log('Daily snapshot sent to ' + admin.Email);
}

/* ═══════════════════════════════════════════════════════
   AI WEEKLY REPORT — Friday 6 PM to admin
═══════════════════════════════════════════════════════ */
function weeklyAiReport() {
  var p     = PropertiesService.getScriptProperties();
  var key   = p.getProperty('ANTHROPIC_API_KEY');
  var admin = readRowsCached('USERS').filter(function(u) { return /admin/i.test(u.Role); })[0];
  if (!admin || !admin.Email) { Logger.log('No admin email for weekly report'); return; }

  var today     = todayStr();
  var weekStart = Utilities.formatDate(new Date(new Date().getTime() - 6 * 86400000), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var tasks     = readRowsCached('TASKS').filter(function(t) { return t.Date >= weekStart && t.Date <= today; });
  var users     = readRowsCached('USERS').filter(function(u) { return !/admin/i.test(u.Role); });

  var rawData = '';
  users.forEach(function(u) {
    var ut       = tasks.filter(function(t) { return same(t.Name, u.Name); });
    var done     = ut.filter(function(t) { return t.Status === 'done'; }).length;
    var offKra   = ut.filter(function(t) { return t.Aligned === 'NO'; }).length;
    var noReport = ut.filter(function(t) { return t.Status !== 'done' && !t.Report; }).length;
    rawData += '\n--- ' + u.Name + ' (' + u.Role + '): ' + ut.length + ' tasks, ' + done + ' done, ' + offKra + ' off-KRA, ' + noReport + ' missing reports';
    ut.slice(0, 4).forEach(function(t) {
      rawData += '\n  [' + t.Status + '] ' + t.Task + (t.Report ? ' → ' + t.Report : '') + (t.Aligned === 'NO' ? ' ⚠️ off-KRA' : '');
    });
  });

  var report = '';
  if (key) {
    try {
      var res  = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
        method: 'post', contentType: 'application/json',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        payload: JSON.stringify({
          model: 'claude-haiku-4-5', max_tokens: 900,
          system: 'You are a performance analyst for Akshardham Associates (real-estate colony developer, India). Write a concise weekly team report in 3 sections: (1) Top performers & why, (2) Who needs attention & why, (3) Top 3 actions for next week. Max 300 words. Simple English.',
          messages: [{ role: 'user', content: 'Week ' + weekStart + ' to ' + today + ':' + rawData }]
        }),
        muteHttpExceptions: true
      });
      var body = JSON.parse(res.getContentText());
      if (res.getResponseCode() === 200)
        report = body.content.map(function(c) { return c.text || ''; }).join('');
      else
        report = 'AI error: ' + res.getContentText();
    } catch (err) {
      report = 'AI error: ' + err;
    }
  } else {
    report = 'ANTHROPIC_API_KEY not set in Script Properties.\n\nRaw data below.';
  }

  var html = '<h2 style="color:#E06318;font-family:sans-serif">📈 Weekly AI Report — ' + weekStart + ' to ' + today + '</h2>' +
    '<div style="font-family:sans-serif;font-size:14px;line-height:1.7;background:#f8f8f8;padding:16px;border-radius:8px;white-space:pre-wrap">' + report + '</div>' +
    '<hr><h3 style="font-family:sans-serif">Raw Data</h3>' +
    '<pre style="font-size:11px;color:#555;white-space:pre-wrap">' + rawData + '</pre>';

  MailApp.sendEmail({ to: admin.Email, subject: '📈 Weekly Team Report — ' + today, htmlBody: html });
  Logger.log('Weekly AI report sent to ' + admin.Email);
}

/* ═══════════════════════════════════════════════════════
   SHEET SETUP
═══════════════════════════════════════════════════════ */
function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(function(name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(SHEETS[name]);
      sh.getRange(1, 1, 1, SHEETS[name].length).setFontWeight('bold').setBackground('#FDF1E2');
      sh.setFrozenRows(1);
    }
  });
  if (sheet('USERS').getLastRow() === 1) {
    [
      ['Krishan',      'Admin',            '1234','','','Team performance review | Targets monitoring | Business growth'],
      ['Raghavendra',  'Sales',            '1234','','','Site visits | Visit-to-booking conversion | Customer follow-up'],
      ['Sunil',        'Field Sales',      '1234','','','Field visits & retailer network | Lead generation on ground | Site visit coordination'],
      ['Kamna',        'Telecaller',       '1234','','','80+ calls daily | Handover hot leads | Update CRM follow-ups'],
      ['Anjali',       'Telecaller',       '1234','','','80+ calls daily | Handover hot leads | Update CRM follow-ups'],
      ['Shafaq',       'Digital Marketing','1234','','','Daily social posts/reels | Lead generation via ads | Enquiry tracking'],
      ['Luv',          'Tech',             '1234','','','Portal & tools uptime | Automation delivery | Data hygiene'],
      ['Leeladhar',    'Accounts',         '1234','','','Record collections | Pending payment follow-up | Day-closing summary'],
      ['Aditi',        'Trainer',          '1234','','','Training sessions delivery | Module completion tracking | New agent onboarding'],
      ['Rupesh',       'Operations',       '1234','','','Registry & paperwork follow-up | Vendor coordination | Site operations']
    ].forEach(function(r) { sheet('USERS').appendRow(r); });
  }
  Logger.log('All sheets ready ✔  Fill Phone/Email in Users, change passwords, then Deploy.');
}

/* ═══════════════════════════════════════════════════════
   CACHE LAYER — CacheService 45s + in-memory per request
═══════════════════════════════════════════════════════ */
var _mem = {};   // in-memory cache (within single execution)

function readRowsCached(name) {
  if (_mem[name]) return _mem[name];
  var cache  = CacheService.getScriptCache();
  var cached = cache.get('sh_' + name);
  if (cached) {
    try {
      var parsed = JSON.parse(cached);
      _mem[name] = parsed;
      return parsed;
    } catch (e) {}
  }
  var rows   = readRows(name);
  _mem[name] = rows;
  try { cache.put('sh_' + name, JSON.stringify(rows), 45); } catch (e) {}
  return rows;
}

function invalidateCache(name) {
  delete _mem[name];
  try { CacheService.getScriptCache().remove('sh_' + name); } catch (e) {}
}

/* ═══════════════════════════════════════════════════════
   SHEET HELPERS — header-driven (column order doesn't matter)
═══════════════════════════════════════════════════════ */
function sheet(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error(name + ' sheet missing — run setupSheets first');
  return sh;
}

function headersOf(name) {
  return sheet(name)
    .getRange(1, 1, 1, Math.max(sheet(name).getLastColumn(), 1))
    .getValues()[0].map(String);
}

function readRows(name) {
  var sh   = sheet(name);
  if (sh.getLastRow() < 2) return [];
  var head = headersOf(name);
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, head.length).getValues();
  var rows = [];
  for (var i = 0; i < vals.length; i++) {
    var o = {}, any = false;
    for (var j = 0; j < head.length; j++) {
      var v = normVal(vals[i][j]);
      o[head[j]] = v;
      if (v !== '') any = true;
    }
    if (any) rows.push(o);
  }
  return rows;
}

function appendRow(name, obj) {
  var head = headersOf(name);
  sheet(name).appendRow(head.map(function(h) { return obj[h] !== undefined ? obj[h] : ''; }));
}

function updateTask(taskId, fields) {
  var sh    = sheet('TASKS');
  var head  = headersOf('TASKS');
  var idCol = head.indexOf('TaskID');
  if (idCol < 0) throw new Error('TASKS sheet needs TaskID column');
  var ids = sh.getRange(2, idCol + 1, Math.max(sh.getLastRow() - 1, 1), 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(taskId)) {
      Object.keys(fields).forEach(function(k) {
        var col = head.indexOf(k);
        if (col >= 0) sh.getRange(i + 2, col + 1).setValue(fields[k]);
      });
      return;
    }
  }
  throw new Error('Task not found: ' + taskId);
}

function setCell(name, rowIndex, headerName, value) {
  var head = headersOf(name);
  var col  = head.indexOf(headerName);
  if (col < 0) throw new Error(headerName + ' column missing in ' + name);
  sheet(name).getRange(rowIndex + 2, col + 1).setValue(value);
}

function findUser(name) {
  var rows = readRowsCached('USERS');
  for (var i = 0; i < rows.length; i++) if (same(rows[i].Name, name)) return rows[i];
  return null;
}

function roleOf(name)       { var u = findUser(name); return u ? u.Role : ''; }
function parseKras(s)       { return String(s || '').split('|').map(function(x) { return x.trim(); }).filter(Boolean); }
function same(a, b)         { return String(a).toLowerCase().trim() === String(b).toLowerCase().trim(); }
function merge(obj, extra)  { var r = {}; Object.keys(obj).forEach(function(k){r[k]=obj[k];}); Object.keys(extra).forEach(function(k){r[k]=extra[k];}); return r; }

function normVal(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v === null || v === undefined ? '' : v;
}

function todayStr() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function dateOffset(n) {
  var d = new Date();
  d.setDate(d.getDate() + n);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
