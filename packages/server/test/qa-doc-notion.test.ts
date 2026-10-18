import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Employee, WorkItem } from '@jkj/shared';
import type { NotionPort } from '../src/services/notion.js';
import type { Workplace } from '../src/services/workplace.js';
import * as items from '../src/services/items.js';
import * as work from '../src/services/work.js';
import * as trail from '../src/services/trail.js';
import * as flow from '../src/services/github-flow.js';
import * as qaDoc from '../src/services/qa-doc.js';
import * as docs from '../src/services/docs.js';
import { employee, workplaceTools } from '../src/services/employees.js';
import { ensureWorktree } from '../src/services/worktrees.js';
import { rawGet } from '../src/services/v2-map.js';
import { testWorkplace, withTree } from './fakes/workplace.js';
import { FakeGitHub } from './fakes/fake-github.js';
import { FakeNotion } from './fakes/fake-notion.js';
import { writePrePr } from './fakes/pre-pr.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';

/**
 * QA docs in Notion (owner, 18 Oct): approval 2's QA doc is written as a child page "QA: <title>" of the
 * story's Notion doc (or its own Iris Docs page when the story has none), linked on the story; approval
 * reads and validates it the same way as the file; owner comments on it reach the QA author; the local
 * file stays as the cache and the fallback when Notion is down. Stories whose QA doc is already a file
 * keep the file (no migration).
 */

const runtime = installFakeRuntime();
after(() => runtime.restore());
const git = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });

function staff(wp: Workplace): void {
  if (wp.org.employees.some(e => e.id === 'arjun')) return;
  const kabir = employee(wp, 'kabir');
  const add = (e: Partial<Employee> & { id: string }) => wp.org.employees.push({ ...kabir, name: e.id[0]!.toUpperCase() + e.id.slice(1), level: 2, ...e } as Employee);
  add({ id: 'arjun', roleId: 'engineer', charterIds: ['memory'], reportsTo: 'kabir' });
  add({ id: 'zoya', roleId: 'engineer', charterIds: ['qa-release'], reportsTo: 'nikhil' });
  add({ id: 'cto', name: 'Vikram', roleId: 'cto', level: 0, charterIds: [], reportsTo: 'coo' });
}

interface Setup {
  wp: Workplace;
  storyId: string;
  wt: string;
  commit(files: Record<string, string>): string;
  done(): Promise<void>;
}

function setup(mode: 'shadow' | 'on' = 'shadow', opts: { author?: string } = {}): Setup {
  const { wp, tmp } = testWorkplace();
  staff(wp);
  const author = employee(wp, opts.author ?? 'kabir');
  writeFileSync(join(wp.config.workplaceDir, 'quality.yaml'), 'maxFileBytes: 100000\nareas: {}\n');
  const gh = new FakeGitHub(author.workspace.repo);
  flow.useGitHub(wp, gh);
  flow.setMode(wp, mode, 'coo');
  const epic = items.create(wp, { level: 'epic', title: 'Memory' }, 'owner');
  const story = items.create(wp, { level: 'story', title: 'Recall the last song', parentId: epic.id, assigneeId: author.id }, 'owner');
  const wt = ensureWorktree(wp.config.workDir, author, story.id).path;
  const commit = (files: Record<string, string>): string => {
    for (const [f, c] of Object.entries(files)) { mkdirSync(join(wt, f, '..'), { recursive: true }); writeFileSync(join(wt, f), c); }
    git(wt, ['add', '-A']);
    git(wt, ['-c', `user.email=${author.id}@iris.local`, '-c', `user.name=${author.id}`, 'commit', '-q', '-m', 'change']);
    const sha = git(wt, ['rev-parse', 'HEAD']).trim();
    writePrePr(wt, sha, { ok: true, by: author.id });
    return sha;
  };
  return { wp, storyId: story.id, wt, commit, done: async () => { await flow.settled(); gh.cleanup(); tmp.cleanup(); } };
}

const evidence = { tests: { passed: 3, failed: 0, command: 'npm test' }, commits: ['abc'], liveVerified: [], notVerified: ['live'] };

async function reviewed(s: Setup, by = 'kabir'): Promise<void> {
  work.reportDone(s.wp, s.storyId, evidence, by);
  await (await flow.onReview(s.wp, s.storyId, by)).tests;
}

function proof(wp: Workplace, rel = 'logs/unit.txt'): string {
  const path = join(qaDoc.evidenceDir(wp), rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'ok\n');
  return rel;
}

/** A QA doc whose cases cite proof; `tail` is the evidence line(s) of the report. */
function qaText(wp: Workplace, tail: string[] = [], cases: string[] = []): string {
  return [
    '## Users affected',
    '- Affected: phone + Mac linked but offline — case(s): provider down',
    '- Not affected: Windows desktop — no Windows code',
    '## Edge cases',
    `- PASS: empty input — unit test evidence: ${proof(wp)}`,
    '- PASS: provider down — killed the provider and checked the reply evidence: https://ci.example.com/runs/42',
    '- N/A: Windows path — no Windows code touched',
    ...cases,
    '## Report',
    'Checked both failure paths by hand and in tests; Windows untouched; residual risk low.',
    ...tail,
  ].join('\n');
}
const NA = ['Evidence: n/a — server-only change with no app surface', 'Tests: npm test 12 passed, 0 failed'];

async function toolsFor(wp: Workplace, employeeId: string, assignmentId?: string) {
  const server = workplaceTools(wp, employeeId, () => ({ agentId: 'a', employeeId, ...(assignmentId ? { assignmentId } : {}), startedAt: '', seen: {}, planCaptured: false }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(st);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(ct);
  return async (name: string, args: Record<string, unknown>) => JSON.stringify((await client.callTool({ name, arguments: args })).content);
}

/** Notion that is down: every call fails. */
function downNotion(): NotionPort {
  return new Proxy({} as NotionPort, { get: () => async () => { throw new Error('Notion 503 service_unavailable: down'); } });
}

/** In review with the developer approval: ready for QA's approval 2. */
async function readyForQa(s: Setup, file = 'services/memory-svc/recall.py'): Promise<void> {
  s.commit({ [file]: `x = ${Math.random()}\n` });
  await reviewed(s);
  await flow.approve(s.wp, s.storyId, 'arjun');
}

const childPages = (notion: FakeNotion, parentId: string) => notion.pageBlocks(parentId).filter(b => b.type === 'child_page');

test('approval 2 writes the QA doc as a child page "QA: <title>" of the story\'s doc, links it, and keeps the file as the cache', async () => {
  const s = setup('shadow');
  const notion = new FakeNotion();
  docs.setNotionPort(s.wp, notion);
  try {
    assert.match(await docs.docWrite(s.wp, 'kabir', { itemId: s.storyId, type: 'Design', title: 'Recall design', markdown: '## Context\n\nx' }), /Doc created/);
    const storyDoc = rawGet(s.wp, s.storyId)!.docId!;
    await readyForQa(s);
    const r = await flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp, NA));
    assert.equal(r.stage, 'qa');
    const w = rawGet(s.wp, s.storyId)!;
    assert.ok(w.qaDoc?.pageId && w.qaDoc.url, 'the story links its QA doc');
    assert.equal(w.qaDoc.by, 'nikhil');
    const kids = childPages(notion, storyDoc);
    assert.equal(kids.length, 1, 'one child page under the story doc');
    assert.equal(kids[0]!.id, w.qaDoc.pageId);
    assert.equal((kids[0]!['child_page'] as { title: string }).title, 'QA: Recall the last song');
    const md = await docs.readQaDocPage(s.wp, w.qaDoc.pageId);
    assert.match(md, /## Edge cases/);
    assert.match(md, /- PASS: empty input/);
    assert.ok(qaDoc.filed(s.wp, s.storyId), 'the local file is kept as the cache');
    assert.ok(trail.activityFor(s.wp, s.storyId).some(a => a.link === w.qaDoc!.url), 'the trail links the QA page');
    assert.equal(w.docId, storyDoc, 'the story doc is unchanged');
  } finally { await s.done(); }
});

test('a story with no doc gets the QA doc as its own Iris Docs page that doc_write never mistakes for the story doc', async () => {
  const s = setup('shadow');
  const notion = new FakeNotion();
  docs.setNotionPort(s.wp, notion);
  try {
    await readyForQa(s);
    await flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp, NA));
    const w = rawGet(s.wp, s.storyId)!;
    const page = notion.pages.get(w.qaDoc!.pageId!);
    assert.ok(page?.parentDb, 'a database page');
    assert.equal((page.properties!['Type'] as { select: { name: string } }).select.name, 'QA report');
    assert.equal(docs.plainText((page.properties!['Name'] as { title: never[] }).title), 'QA: Recall the last song');
    assert.equal(w.docId, undefined);
    assert.match(await docs.docWrite(s.wp, 'kabir', { itemId: s.storyId, type: 'Design', markdown: '## Context\n\nx' }), /Doc created/);
    assert.notEqual(rawGet(s.wp, s.storyId)!.docId, w.qaDoc!.pageId);
  } finally { await s.done(); }
});

test('Notion down: approval still goes through on the local file, with a warning; the next write retries Notion', async () => {
  const s = setup('on');
  docs.setNotionPort(s.wp, downNotion());
  try {
    await readyForQa(s);
    const r = await flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp));
    assert.equal(r.stage, 'qa');
    assert.match(r.message, /Notion/);
    const w = rawGet(s.wp, s.storyId)!;
    assert.ok(w.qaDoc, 'the QA doc is recorded');
    assert.equal(w.qaDoc.pageId, undefined);
    assert.ok(qaDoc.filed(s.wp, s.storyId));
    const notion = new FakeNotion();
    docs.setNotionPort(s.wp, notion);
    const out = await flow.amendQaDoc(s.wp, s.storyId, 'nikhil', qaText(s.wp, NA));
    assert.match(out.message, /QA doc updated/);
    assert.ok(rawGet(s.wp, s.storyId)!.qaDoc?.pageId, 'written to Notion once it is back');
  } finally { await s.done(); }
});

test('approval 2 without qaDoc text reads the Notion QA doc and validates it the same way', async () => {
  const s = setup('shadow');
  const notion = new FakeNotion();
  docs.setNotionPort(s.wp, notion);
  try {
    await readyForQa(s);
    // QA's doc already in Notion (an earlier approval that a new commit reset): the page stays.
    const page = (await docs.writeQaDocPage(s.wp, 'nikhil', rawGet(s.wp, s.storyId)!, qaText(s.wp, NA)))!;
    work.saveQuiet(s.wp, { ...rawGet(s.wp, s.storyId)!, qaDoc: { by: 'nikhil', at: new Date().toISOString(), sha: 'old', pageId: page.id, url: page.url } });
    const pageId = page.id;
    // Someone edits the page in Notion down to a thin doc: refused like the file would be.
    for (const b of notion.pageBlocks(pageId)) await notion.deleteBlock(b.id!);
    await notion.seed(pageId, docs.markdownToBlocks('## Edge cases\n- PASS: x\n## Report\nshort'));
    await assert.rejects(flow.approve(s.wp, s.storyId, 'nikhil'), /The QA doc is not complete/);
    for (const b of notion.pageBlocks(pageId)) await notion.deleteBlock(b.id!);
    await notion.seed(pageId, docs.markdownToBlocks(qaText(s.wp, NA)));
    const r = await flow.approve(s.wp, s.storyId, 'nikhil');
    assert.equal(r.stage, 'qa');
    assert.equal(rawGet(s.wp, s.storyId)!.qaDoc!.pageId, pageId, 'the same page, not a new one');
  } finally { await s.done(); }
});

test('no QA doc anywhere: approval 2 without text is refused as before', async () => {
  const s = setup('shadow');
  docs.setNotionPort(s.wp, new FakeNotion());
  try {
    await readyForQa(s);
    await assert.rejects(flow.approve(s.wp, s.storyId, 'nikhil'), /needs the QA doc/);
  } finally { await s.done(); }
});

test('a story whose QA doc is already a file keeps the file: no Notion page, and approval accepts the file', async () => {
  const s = setup('shadow');
  const notion = new FakeNotion();
  docs.setNotionPort(s.wp, notion);
  try {
    await readyForQa(s);
    // Filed before the move to Notion: a file, no qaDoc record on the story.
    qaDoc.file(s.wp, s.storyId, { title: 'Recall the last song', by: 'nikhil', sha: 'abcdef12', at: '2026-10-10T00:00:00Z' }, qaText(s.wp, NA));
    const r = await flow.approve(s.wp, s.storyId, 'nikhil');
    assert.equal(r.stage, 'qa');
    assert.equal(notion.count('createPage'), 0, 'nothing written to Notion');
    assert.equal(rawGet(s.wp, s.storyId)!.qaDoc?.pageId, undefined);
    await flow.amendQaDoc(s.wp, s.storyId, 'nikhil', qaText(s.wp, NA, ['- N/A: new case — later']));
    assert.equal(notion.count('createPage'), 0, 'a new doc on a file-QA story stays a file');
    assert.match(qaDoc.filed(s.wp, s.storyId)!, /new case/);
  } finally { await s.done(); }
});

test('qa_doc_update rewrites the same Notion page', async () => {
  const s = setup('on');
  const notion = new FakeNotion();
  docs.setNotionPort(s.wp, notion);
  try {
    await readyForQa(s);
    await flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp));
    const pageId = rawGet(s.wp, s.storyId)!.qaDoc!.pageId!;
    const nikhil = await toolsFor(s.wp, 'nikhil');
    assert.match(await nikhil('qa_doc_update', { itemId: s.storyId, qaDoc: qaText(s.wp, NA) }), /QA doc updated/);
    assert.equal(rawGet(s.wp, s.storyId)!.qaDoc!.pageId, pageId);
    assert.equal(notion.count('createPage'), 1);
    assert.match(await docs.readQaDocPage(s.wp, pageId), /Evidence: n\/a/);
  } finally { await s.done(); }
});

test("owner comments on the QA page reach the QA author, not the developer; the story doc's sweep skips the child page", async () => {
  const s = setup('shadow');
  const notion = new FakeNotion();
  docs.setNotionPort(s.wp, notion);
  try {
    await docs.docWrite(s.wp, 'kabir', { itemId: s.storyId, type: 'Design', title: 'Recall design', markdown: '## Context\n\nx' });
    await readyForQa(s);
    await flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp, NA));
    const w = rawGet(s.wp, s.storyId)!;
    assert.equal(w.status, 'done', 'QA docs belong to done stories: the relay still covers them');
    const pageId = w.qaDoc!.pageId!;
    notion.ownerComments(pageId, 'Why is Windows N/A?');
    const caseBlock = notion.pageBlocks(pageId).find(b => /provider down/.test(JSON.stringify(b)))!;
    notion.ownerComments(caseBlock.id!, 'Show the log line.');
    const delivered: { to: string; text: string }[] = [];
    // The story doc is done too; reopen it so its sweep runs and must skip the child page.
    work.saveQuiet(s.wp, { ...rawGet(s.wp, s.storyId)!, status: 'in-progress' } as WorkItem);
    await docs.relaySweep(s.wp, { deliver: (to, text) => { delivered.push({ to, text }); } });
    assert.equal(delivered.length, 2, JSON.stringify(delivered));
    assert.ok(delivered.every(d => d.to === 'nikhil'));
    assert.ok(delivered.some(d => /Why is Windows N\/A/.test(d.text) && /QA doc/.test(d.text)));
    assert.ok(delivered.some(d => /Show the log line/.test(d.text) && /provider down/.test(d.text)));
    assert.equal(await docs.relaySweep(s.wp, { deliver: (to, text) => { delivered.push({ to, text }); } }), 0, 'once');
  } finally { await s.done(); }
});

test("a developer's doc_write section rewrite never deletes the QA child page", async () => {
  const s = setup('shadow');
  const notion = new FakeNotion();
  docs.setNotionPort(s.wp, notion);
  try {
    await docs.docWrite(s.wp, 'kabir', { itemId: s.storyId, type: 'Design', title: 'Recall design', markdown: '## Context\n\nx' });
    await readyForQa(s);
    await flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp, NA));
    const storyDoc = rawGet(s.wp, s.storyId)!.docId!;
    assert.match(await docs.docWrite(s.wp, 'kabir', { itemId: s.storyId, type: 'Design', title: 'Recall design', markdown: '## Context\n\ny' }), /replaced/);
    assert.equal(childPages(notion, storyDoc).length, 1);
    assert.ok(notion.pages.has(rawGet(s.wp, s.storyId)!.qaDoc!.pageId!));
  } finally { await s.done(); }
});

test('doc_read and doc_comment reach the QA doc with qa: true; item_read links it', async () => {
  const s = setup('shadow');
  const notion = new FakeNotion();
  docs.setNotionPort(s.wp, notion);
  try {
    await readyForQa(s);
    await flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp, NA));
    const w = rawGet(s.wp, s.storyId)!;
    const nikhil = await toolsFor(s.wp, 'nikhil');
    assert.match(await nikhil('doc_read', { itemId: s.storyId, qa: true }), /PASS: empty input/);
    assert.match(await nikhil('doc_comment', { itemId: s.storyId, qa: true, text: 'Answered: see the log.' }), /Commented on the QA doc/);
    assert.ok(notion.comments.some(c => c.parent.type === 'page_id' && c.parent.page_id === w.qaDoc!.pageId));
    assert.ok((await nikhil('item_read', { itemId: s.storyId })).includes(w.qaDoc!.url!));
  } finally { await s.done(); }
});

test('new QA docs need "## Users affected" through the tool; a file-QA story without one keeps working', async () => {
  const s = setup('shadow');
  docs.setNotionPort(s.wp, new FakeNotion());
  try {
    await readyForQa(s);
    const nikhil = await toolsFor(s.wp, 'nikhil');
    await nikhil('item_read', { itemId: s.storyId });
    const noUsers = qaText(s.wp, NA).replace(/## Users affected[\s\S]*?(?=## Edge cases)/, '');
    assert.match(await nikhil('review_approve', { itemId: s.storyId, qaDoc: noUsers }), /Not approved: .*Users affected/);
    const empty = qaText(s.wp, NA).replace(/- (Not )?[Aa]ffected:.*\n/g, '');
    assert.match(await nikhil('review_approve', { itemId: s.storyId, qaDoc: empty }), /Not approved: .*lists no rows/);
    assert.match(await nikhil('review_approve', { itemId: s.storyId, qaDoc: qaText(s.wp, NA) }), /QA approval recorded/);
  } finally { await s.done(); }
  const old = setup('shadow');
  try {
    await readyForQa(old);
    const noUsers = qaText(old.wp, NA).replace(/## Users affected[\s\S]*?(?=## Edge cases)/, '');
    qaDoc.file(old.wp, old.storyId, { title: 'Recall the last song', by: 'nikhil', sha: 'abcdef12', at: '2026-10-10T00:00:00Z' }, noUsers);
    const nikhil = await toolsFor(old.wp, 'nikhil');
    await nikhil('item_read', { itemId: old.storyId });
    assert.match(await nikhil('review_approve', { itemId: old.storyId }), /QA approval recorded/);
  } finally { await old.done(); }
});
