// ==UserScript==
// @name         Jira · GitHub Tag Issue Lookup
// @namespace    local.jira.github
// @version      1.0.0
// @description  In Jira, view the PRs, issues and available status transitions added between GitHub tags.
// @match        https://*.atlassian.net/*
// @exclude      https://*.atlassian.net/wiki*
// @connect      api.github.com
// @grant        GM.xmlHttpRequest
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  // For Jira Data Center, change @match above to the Jira site, including its
  // context path, e.g. https://jira.example.com/jira/*. Most installations
  // publish the context path in this meta tag.
  const contextPath = document.querySelector('meta[name="ajs-context-path"]')?.content || '';
  const JIRA_BASE = location.origin + (/^\/(?!\/)[\w./~-]*$/.test(contextPath)
    ? contextPath.replace(/\/$/, '') : '');

  function normalizeRepo(value) {
    const path = value.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').replace(/\.git$/, '');
    const parts = path.split('/');
    if (parts.length !== 2 || parts.some(part => !/^[\w.-]+$/.test(part) || /^\.{1,2}$/.test(part))) {
      throw new Error('Enter owner/repo or a full https://github.com/owner/repo URL.');
    }
    return path;
  }

  function githubReader(repo, token) {
    const headers = { Accept: 'application/vnd.github+json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return async function read(path) {
      const request = GM.xmlHttpRequest({
        method: 'GET',
        url: 'https://api.github.com/repos/' + repo + path,
        headers,
        anonymous: true,
        redirect: 'error',
        responseType: 'json',
      });
      const timeout = setTimeout(() => request.abort(), 45_000);
      let response;
      try {
        response = await request;
      } catch {
        throw new Error('Could not reach the GitHub API. Check your network and the Tampermonkey connection permission for api.github.com, then try again.');
      } finally {
        clearTimeout(timeout);
      }
      if (response.status === 200 && response.response != null) return response.response;
      if (response.status === 401) throw new Error('GitHub authentication failed. Check that the token is valid.');
      const exhausted = /^x-ratelimit-remaining:\s*0\s*$/im.test(response.responseHeaders || '');
      if (exhausted || response.status === 429 || /rate limit/i.test(response.response?.message || '')) {
        throw new Error('GitHub API rate limit reached. Try again later. A read-only token raises the limit for public repos.');
      }
      if ([403, 404].includes(response.status)) {
        throw new Error('GitHub could not read the requested data (HTTP ' + response.status + '). Check the repo, the tags, which repos the token can access, and its Contents and Pull requests read permissions.');
      }
      throw new Error('The GitHub API did not return the expected data (HTTP ' + response.status + ').');
    };
  }

  async function readJira(path) {
    let response;
    try {
      response = await fetch(JIRA_BASE + '/rest/api/2/' + path, {
        credentials: 'same-origin',
        mode: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error('The Jira request timed out or failed. Check that you are signed in.');
    }
    if (!response.ok) {
      throw new Error('The Jira request failed (HTTP ' + response.status + '). Check the issue, your sign-in and your permissions.');
    }
    try {
      return await response.json();
    } catch {
      throw new Error('Jira did not return JSON. Check the Jira URL and that you are signed in.');
    }
  }

  async function issueDetails(key) {
    const details = {};
    try {
      const issuePath = 'issue/' + encodeURIComponent(key);
      const {fields} = await readJira(issuePath + '?fields=summary,status,assignee');
      if (!fields?.status?.name) throw new Error('Jira did not return the issue status.');
      details.summary = fields.summary;
      details.assignee = fields.assignee;
      details.status = fields.status.name;
      const {transitions} = await readJira(issuePath + '/transitions');
      if (!Array.isArray(transitions)) throw new Error('Jira did not return the available transitions.');
      details.targets = [...new Set(transitions.map(t => t.to?.name)
        .filter(name => name && name !== details.status))];
    } catch (error) {
      details.error = error.message;
    }
    return details;
  }

  async function runComparison({repo, startTag, endTag, tagPattern, token, onlyMine}, progress) {
    repo = normalizeRepo(repo);
    // Jira Cloud identifies users by accountId, Data Center by key or name.
    const userId = user => user?.accountId || user?.key || user?.name;
    const me = onlyMine && userId(await readJira('myself'));
    if (onlyMine && !me) throw new Error('Jira did not return the current user.');
    const report = await buildTagReport({
      startTag, endTag, tagPattern, github: githubReader(repo, token), progress,
    });
    const issues = report.sections.flatMap(section => section.issues);
    const keys = [...new Set(issues.map(issue => issue.key))];
    const details = new Map();
    for (const key of keys) {
      progress('Reading Jira issue ' + (details.size + 1) + '/' + keys.length + ' · ' + key);
      details.set(key, await issueDetails(key));
    }
    for (const issue of issues) issue.jira = details.get(issue.key);
    if (onlyMine) {
      for (const section of report.sections) {
        // Issues that could not be read stay visible: their assignee is unknown.
        section.issues = section.issues.filter(({jira}) => jira.error || userId(jira.assignee) === me);
      }
    }
    return {...report, repo, onlyMine};
  }

  async function buildTagReport({ startTag, endTag, tagPattern = '', github, progress = () => {} }) {
    async function list(path) {
      const items = [];
      for (let page = 1; ; page++) {
        const batch = await github(`${path}?per_page=100&page=${page}`);
        if (!Array.isArray(batch)) throw new Error('GitHub returned a list in an unexpected format.');
        items.push(...batch);
        if (batch.length < 100) return items;
      }
    }

    progress('Fetching GitHub tags…');
    // The tags endpoint provides the target commit for both annotated and lightweight tags.
    const tags = new Map((await list('/tags')).map(tag => [tag.name, tag.commit.sha]));
    const start = tags.get(startTag);
    const end = tags.get(endTag);
    if (!start || !end) throw new Error(`Tag "${!start ? startTag : endTag}" not found. Check the name and letter case.`);
    if (start === end) return { sections: [], skippedTags: [] };

    const commits = new Map();
    progress('Comparing the commits between the two tags…');
    for (let page = 1; ; page++) {
      const result = await github(`/compare/${start}...${end}?per_page=100&page=${page}`);
      if (result.status !== 'ahead' || result.merge_base_commit?.sha !== start) {
        throw new Error('The end tag must descend from the start tag. Check the tag order and the release line.');
      }
      const before = commits.size;
      for (const commit of result.commits) commits.set(commit.sha, commit);
      if (commits.size === result.total_commits) break;
      if (commits.size === before || result.commits.length < 100) {
        throw new Error('Could not fetch the complete commit list from GitHub. Narrow the range and try again.');
      }
    }

    const glob = (tagPattern || '*').replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*+/g, '.*').replace(/\?/g, '.');
    const matches = new RegExp(`^${glob}$`);
    const tagNames = new Map();
    for (const [name, sha] of tags) {
      if (name !== startTag && name !== endTag && !matches.test(name)) continue;
      if (sha !== start && !commits.has(sha)) continue;
      if (!tagNames.has(sha)) tagNames.set(sha, []);
      tagNames.get(sha).push(name);
    }
    for (const names of tagNames.values()) names.sort();
    // Place the expressly selected name first when several tags name the boundary.
    for (const [sha, name] of [[start, startTag], [end, endTag]]) {
      tagNames.set(sha, [name, ...tagNames.get(sha).filter(alias => alias !== name)]);
    }

    const boundaries = [];
    const firstParents = new Set();
    for (let sha = end; sha !== start; ) {
      const commit = commits.get(sha);
      if (!commit || firstParents.has(sha)) {
        throw new Error('The two tags are not on the same first-parent release line, so commits cannot be assigned to releases in order.');
      }
      firstParents.add(sha);
      if (tagNames.has(sha)) boundaries.push(sha);
      sha = commit.parents[0]?.sha;
    }
    boundaries.reverse();
    const skippedTags = [...tagNames].filter(([sha]) => sha !== start && !firstParents.has(sha))
      .flatMap(([, names]) => names).sort();

    // Walk all parents of each boundary in release order. A commit belongs to the
    // first boundary that reaches it, including changes brought in by a branch merge.
    const sectionFor = new Map();
    const sections = boundaries.map((boundary, index) => {
      const pending = [boundary];
      while (pending.length) {
        const sha = pending.pop();
        if (sectionFor.has(sha) || !commits.has(sha)) continue;
        sectionFor.set(sha, index);
        for (const parent of commits.get(sha).parents) pending.push(parent.sha);
      }
      return {
        fromTags: tagNames.get(boundaries[index - 1] || start),
        toTags: tagNames.get(boundary), issues: [], review: []
      };
    });
    if (sectionFor.size !== commits.size) throw new Error('Could not assign every commit in the range to a release.');

    const associations = new Map();
    const mergedBySha = new Map();
    const prsByNumber = new Map();
    let inspected = 0;
    for (const sha of commits.keys()) {
      progress(`Looking up PRs for commits (${++inspected} / ${commits.size})…`);
      const linked = [];
      for (const raw of await list(`/commits/${sha}/pulls`)) {
        const pr = { number: raw.number, title: raw.title, mergeSha: raw.merged_at && raw.merge_commit_sha };
        linked.push(pr);
        if (!sectionFor.has(pr.mergeSha) || prsByNumber.has(pr.number)) continue;
        prsByNumber.set(pr.number, pr);
        if (!mergedBySha.has(pr.mergeSha)) mergedBySha.set(pr.mergeSha, []);
        mergedBySha.get(pr.mergeSha).push(pr);
      }
      associations.set(sha, linked);
    }

    const prefix = /^\[([A-Z][A-Z0-9_]*-\d+)\]/;
    const isRevertTitle = title => /^revert(?:s|ed)?\b/i.test(title.replace(prefix, '').trim());
    const toLink = ({ number, title }) => ({ number, title });
    const reviewOnly = new Set();
    for (const [sha, commit] of commits) {
      const index = sectionFor.get(sha);
      const section = sections[index];
      const message = commit.commit.message;
      const title = message.split('\n')[0];
      const linked = new Map(associations.get(sha).map(pr => [pr.number, pr]));
      for (const pr of mergedBySha.get(sha) || []) linked.set(pr.number, pr);
      const valid = [...linked.values()].filter(pr => sectionFor.get(pr.mergeSha) === index);
      const reverts = valid.filter(pr => isRevertTitle(pr.title));
      const revertedSha = message.match(/\bThis reverts commit ([a-f\d]{40})\b/i)?.[1]?.toLowerCase();
      if (isRevertTitle(title) || revertedSha || reverts.length) {
        // Git's standard revert records its target SHA. Keep the original in
        // earlier releases, and withhold both sides of a same-release reversal.
        const related = new Map(valid.map(pr => [pr.number, pr]));
        const originals = [...(associations.get(revertedSha) || []), ...(mergedBySha.get(revertedSha) || [])];
        for (const pr of originals) {
          if (!sectionFor.has(pr.mergeSha)) continue;
          related.set(pr.number, pr);
          if (sectionFor.get(pr.mergeSha) === index) reviewOnly.add(pr.number);
        }
        for (const pr of valid) reviewOnly.add(pr.number);
        section.review.push({ sha, title, reason: 'Revert detected. Check the affected issues and the final content.', prs: [...related.values()].map(toLink) });
      } else if (!valid.length) {
        const reason = linked.size ? 'The linked PR is not merged, or its merge commit is outside this section.' : 'No linked PR found.';
        section.review.push({ sha, title, reason, prs: [...linked.values()].map(toLink) });
      }
    }

    const groups = sections.map(() => new Map());
    for (const pr of prsByNumber.values()) {
      if (reviewOnly.has(pr.number)) continue;
      const index = sectionFor.get(pr.mergeSha);
      const key = pr.title.match(prefix)?.[1];
      if (!key) {
        sections[index].review.push({
          sha: pr.mergeSha, title: pr.title, reason: 'The PR title does not start with a [Jira key].', prs: [toLink(pr)]
        });
        continue;
      }
      if (!groups[index].has(key)) groups[index].set(key, []);
      groups[index].get(key).push(toLink(pr));
    }
    const seen = new Set();
    for (const [index, group] of groups.entries()) {
      for (const key of [...group.keys()].sort()) {
        const prs = group.get(key).sort((a, b) => a.number - b.number);
        sections[index].issues.push({ key, prs, firstSeen: !seen.has(key) });
        seen.add(key);
      }
    }
    return { sections, skippedTags };
  }

  function initUI() {
    const hostId = 'jira-github-tag-report-launcher';
    if (document.getElementById(hostId)) return;

    const host = document.createElement('div');
    host.id = hostId;
    const root = host.attachShadow({ mode: 'closed' });
    document.body.append(host);

    function element(tag, text, className) {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    }

    function link(url, label) {
      const anchor = element('a', label);
      anchor.href = url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      return anchor;
    }

    const style = element('style');
    style.textContent = `
      :host { all: initial; position: fixed; top: 0; right: 0; height: 100vh; display: flex;
        align-items: center; pointer-events: none; z-index: 2147483646;
        font: 14px/1.45 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #172b4d; color-scheme: light; }
      *, *::before, *::after { box-sizing: border-box; }
      [hidden] { display: none !important; }
      button, input { font: inherit; }
      button { cursor: pointer; color: inherit; }
      a { color: #0c56ae; text-decoration: underline; text-underline-offset: 2px; }
      button:focus-visible, input:focus-visible, a:focus-visible, summary:focus-visible {
        outline: 3px solid #388bff; outline-offset: 2px;
      }
      .run { border: 0; border-radius: 5px; background: #0c56ae; color: #fff;
        padding: 8px 14px; font-weight: 600; }
      .launcher, .panel { pointer-events: auto; }
      .launcher { flex: none; border: 0; padding: 0; background: #0c56ae; overflow: hidden;
        border-radius: 8px 0 0 8px; box-shadow: -2px 2px 8px #172b4d33; }
      .launcher img { display: block; width: 44px; height: 44px; }
      .panel { height: 100vh; width: min(570px, calc(100vw - 44px)); overflow-y: auto;
        overscroll-behavior: contain; background: #fff; border-left: 1px solid #b6c2cf;
        box-shadow: -8px 0 32px #172b4d40; padding: 16px; overflow-wrap: anywhere; }
      header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      h2, h3, h4, p, ul { margin: 0; }
      h2 { font-size: 18px; } h3 { font-size: 16px; } h4 { font-size: 14px; }
      .close { background: transparent; border: 0; border-radius: 4px; padding: 5px 8px; }
      .close:hover { background: #edf1f5; }
      form, .two { display: grid; gap: 9px; } form { margin-top: 12px; }
      .two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      label { display: grid; gap: 3px; font-weight: 600; }
      input { min-width: 0; border: 1px solid #8590a2; border-radius: 4px; padding: 6px 8px;
        background: #fff; color: #172b4d; font-weight: 400; }
      summary { cursor: pointer; } .advanced label { margin-top: 8px; }
      .check { display: flex; align-items: center; gap: 6px; font-weight: 400; }
      .run { justify-self: start; } .run:disabled { opacity: .6; cursor: progress; }
      .status, .hint, .meta { color: #44546f; }
      .status:not(:empty), .hint { margin-top: 8px; }
      .status.error, .warning { color: #903b00; }
      .section { padding: 12px 0; border-top: 1px solid #d5dce3; margin-top: 10px; }
      .issue-list, .review-list { margin: 6px 0 0; padding-inline-start: 19px; }
      li + li { margin-top: 8px; }
      .meta { font-size: 13px; } .section h4 { margin-top: 8px; }
      .pr-links { display: flex; gap: 8px; flex-wrap: wrap; }
    `;

    const panel = element('section', undefined, 'panel');
    panel.id = 'tag-report-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'tag-report-title');
    panel.hidden = true;
    const header = element('header');
    const heading = element('h2', 'Jira issues by GitHub tag');
    heading.id = 'tag-report-title';
    const close = element('button', 'Close', 'close');
    close.type = 'button';
    header.append(heading, close);

    const form = element('form');
    form.autocomplete = 'off';
    function inputField(parent, name, labelText, placeholder, required = false, type = 'text') {
      const label = element('label', labelText);
      const input = element('input');
      input.name = name;
      input.type = type;
      input.placeholder = placeholder;
      input.required = required;
      input.autocapitalize = 'none';
      input.autocomplete = type === 'password' ? 'new-password' : 'off';
      input.spellcheck = false;
      label.append(input);
      parent.append(label);
      return input;
    }

    const repo = inputField(form, 'repo', 'GitHub repo', 'owner/repo or GitHub repo URL', true);
    const tags = element('div', undefined, 'two');
    form.append(tags);
    const start = inputField(tags, 'start', 'Start tag (exclusive)', 'v1.2.0', true);
    const end = inputField(tags, 'end', 'End tag (inclusive)', 'v1.5.0', true);
    const advanced = element('details', undefined, 'advanced');
    advanced.append(element('summary', 'Tag filter and private repo access'));
    const pattern = inputField(advanced, 'pattern', 'Intermediate tag name filter (optional)', 'e.g. v1.*, supports * and ?');
    const token = inputField(advanced, 'token', 'GitHub token (required for private repos)', 'Used for this query only', false, 'password');
    form.append(advanced);
    const mineLabel = element('label', undefined, 'check');
    const mine = element('input');
    mine.type = 'checkbox';
    mineLabel.append(mine, 'Only issues assigned to me');
    form.append(mineLabel);
    const run =element('button', 'Compare tags', 'run');
    run.type = 'submit';
    form.append(run);

    const status = element('p', '', 'status');
    status.setAttribute('role', 'status');
    const result = element('div');
    panel.append(header, form, status, result);
    const launcher = element('button', undefined, 'launcher');
    launcher.type = 'button';
    launcher.title = 'Jira issues by GitHub tag';
    const icon = element('img');
    // jg-icon.png, embedded so the script stays a single file.
    icon.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgBAMAAAAQtmoLAAAAMFBMVEX////4+v3r8fjc5/PN3e+/0umwyOWXt9xyndBgkMpOhMQycLsiZbUYX7IRWbAMVq6uCSHrAAABg0lEQVR42mP4TyJgGNUwqmFUw6iGUQ2DTkMCA8N8ZP6OFEVh93nEa9jKAAJMfcRqeMYAAcz7idPwxwGqgUGKOA1XYOoZGPcTpQHIYcg8d7oZSPkRo+EXUKEWkP5bwMDASYyGL8DwATvlGwMDCzEaFsAM/iPAwHCfCA1Al/hDWCUuLvuJ0GDAwNBPStL4A/TzflI0/AYGP0mJDxiqTFCvMCA5DreGn8A0RJyGP2AV3L9I1fAbv5P+hIZGYGgARxcuDQwM7Kga/ikwMKyHSF7EouEvAwMbqgYQux4iOQGbHwQYWCEa1sNEGhgYZCAsB2waHMBedEDScAmYSMFp7jvWUAKbDUqX52EiIHXWQPpfAVYNQHda3V0CDXuItwzAOe52M/Z4uATNvuyISNkIz9LYNPyASuogNPxSgIppYdPwLwC9fPj/fzNEPdN+BWxJ4xpY0hs5ofxrAovlAAMPW1raESyoUvUeJWn9Xe4kqFoNCsL+0RpoVMOohlENoxpGNYxqQNMAACJJfONSlwO8AAAAAElFTkSuQmCC';
    icon.alt = launcher.title;
    launcher.append(icon);
    launcher.setAttribute('aria-controls', panel.id);
    launcher.setAttribute('aria-expanded', 'false');
    root.append(style, launcher, panel);

    function setOpen(open) {
      panel.hidden = !open;
      launcher.setAttribute('aria-expanded', String(open));
      if (open) repo.focus();
      else launcher.focus();
    }
    launcher.addEventListener('click', () => setOpen(panel.hidden));
    close.addEventListener('click', () => setOpen(false));
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !panel.hidden) {
        event.stopPropagation();
        setOpen(false);
      }
    });

    function renderReport(report) {
      const repoUrl = 'https://github.com/' + report.repo;
      function prLinks(prs) {
        const links = element('div', undefined, 'pr-links');
        for (const pr of prs) {
          const anchor = link(repoUrl + '/pull/' + encodeURIComponent(pr.number), 'PR #' + pr.number);
          anchor.title = pr.title;
          links.append(anchor);
        }
        return links;
      }

      const content = document.createDocumentFragment();
      if (!report.sections.length) {
        content.append(element('p', 'Both tags point to the same commit, so this range has no new changes.', 'hint'));
      } else {
        content.append(element('p', 'Each section lists the issues mentioned by its newly included PRs. "First" is relative to the range of this query. The available transitions depend on the permissions of the account signed in to Jira.', 'hint'));
      }
      if (report.onlyMine) {
        content.append(element('p', 'Showing only issues assigned to you. Changes to review are not filtered.', 'hint'));
      }
      if (report.skippedTags.length) {
        const aside = element('details');
        aside.append(element('summary', 'Side-branch tags not used as sections (' + report.skippedTags.length + ')'),
          element('p', report.skippedTags.join(', '), 'meta'));
        content.append(aside);
      }

      for (const section of report.sections) {
        const container = element('section', undefined, 'section');
        const range = section.fromTags.join(' / ') + ' → ' + section.toTags.join(' / ');
        container.append(element('h3', range));
        container.append(element('p', 'Linked issues: ' + section.issues.length + ' · To review: ' + section.review.length, 'meta'));
        if (section.issues.length) {
          const list = element('ul', undefined, 'issue-list');
          for (const issue of section.issues) {
            const item = element('li');
            const issueUrl = JIRA_BASE + '/browse/' + encodeURIComponent(issue.key);
            item.append(link(issueUrl, issue.key), ' · ' + (issue.firstSeen ? 'first in this range' : 'follow-up PR'));
            const jira = issue.jira;
            if (jira?.summary) item.append(element('div', jira.summary));
            if (jira?.status) {
              let line = 'Status: ' + jira.status;
              if (Array.isArray(jira.targets)) line += ' · Can move to: ' + (jira.targets.join(', ') || 'none');
              item.append(element('div', line, 'meta'));
            }
            if (jira?.error) item.append(element('div', jira.error, 'warning'));
            item.append(prLinks(issue.prs));
            list.append(item);
          }
          container.append(list);
        }
        if (section.review.length) {
          const details = element('details');
          details.append(element('summary', 'Changes to review (' + section.review.length + ')'));
          const list = element('ul', undefined, 'review-list');
          for (const row of section.review) {
            const item = element('li');
            if (row.sha) item.append(link(repoUrl + '/commit/' + encodeURIComponent(row.sha), row.sha.slice(0, 8)), ' ');
            item.append(row.title, element('div', row.reason, 'warning'));
            if (row.prs.length) item.append(prLinks(row.prs));
            list.append(item);
          }
          details.append(list);
          container.append(details);
        }
        content.append(container);
      }
      result.replaceChildren(content);
    }

    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (run.disabled) return;
      run.disabled = true;
      result.replaceChildren();
      status.className = 'status';
      status.textContent = 'Querying GitHub…';
      const params = { repo: repo.value.trim(), startTag: start.value.trim(), endTag: end.value.trim(),
        tagPattern: pattern.value.trim(), token: token.value.trim(), onlyMine: mine.checked };
      token.value = '';
      try {
        const report = await runComparison(params, message => { status.textContent = message; });
        renderReport(report);
        status.textContent = 'Finished comparing ' + report.repo + '. Release ranges: ' + report.sections.length + '.';
      } catch (error) {
        status.className = 'status error';
        status.textContent = String(error?.message || 'Query failed. Try again.');
      } finally {
        run.disabled = false;
      }
    });
  }

  initUI();
})();
