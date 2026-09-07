import * as assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import type { Course } from '../core/course';
import { activityKey } from '../core/progress';
import type { Progress } from '../core/progress';
import { renderMarkdown } from '../ui/render';
import { activityLabel, activityStatus, boundProgress, completionSummary, unitLabel } from '../ui/status';

describe('Markdown rendering (no VS Code runtime)', () => {
	it('preserves safe Markdown, tables, lists, and code', () => {
		const html = renderMarkdown('# Lesson\n\n**Strong** and *emphasis*.\n\n- First\n- Second\n\n| Name | Value |\n| --- | --- |\n| A | B |\n\n```typescript\nconst x = 1;\n```');
		for (const tag of ['h1', 'strong', 'em', 'ul', 'li', 'table', 'thead', 'tbody', 'th', 'td', 'pre']) {
			assert.match(html, new RegExp(`<${tag}(?:>|\\s)`));
		}
		assert.match(html, /<code class="language-typescript">const x = 1;/u);
	});

	it('preserves details and summary while removing active HTML', () => {
		const html = renderMarkdown('<details open ontoggle="attack()"><summary onclick="attack()">Answer</summary><p>Safe</p><script>attack()</script></details>');
		assert.match(html, /<details open(?:="")?>/u);
		assert.match(html, /<summary>Answer<\/summary>/u);
		assert.match(html, /<p>Safe<\/p>/u);
		assert.doesNotMatch(html, /attack|ontoggle|onclick|<script/iu);
	});

	it('creates inert, keyboard-accessible HTTPS links that require the host', () => {
		const html = renderMarkdown('[Documentation](https://example.com/docs?q=one&lang=en "Read more")');
		assert.match(html, /<a data-href="https:\/\/example\.com\/docs\?q=one&amp;lang=en"/u);
		assert.match(html, /role="link" tabindex="0"/u);
		assert.match(html, /Open example\.com \(confirmation required\)/u);
		assert.doesNotMatch(html, /\shref=|\starget=|\sdownload=/iu);
	});

	it('allows case-insensitive HTTPS and explicit ports without automatic navigation', () => {
		const html = renderMarkdown('<a href="HTTPS://example.com:8443/path#part">Link</a>');
		assert.match(html, /data-href="HTTPS:\/\/example\.com:8443\/path#part"/u);
		assert.doesNotMatch(html, /\shref=/iu);
	});

	it('strips local, non-HTTPS, executable, and protocol-relative destinations', () => {
		for (const href of [
			'http://example.com', '//example.com', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)',
			'java&#x73;cript:alert(1)', 'java&#10;script:alert(1)', 'command:certLearner.reset',
			'vscode://extension/action', 'file:///C:/secret.txt', 'data:text/html,attack',
			'vbscript:attack()', 'mailto:someone@example.com', 'lesson.md', './lab.ipynb',
			'../outside.md', '/absolute', '#anchor', 'C:/Windows/file', 'https:example.com'
		]) {
			const html = renderMarkdown(`<a href="${href}">Keep this label</a>`);
			assert.match(html, /Keep this label/u, href);
			assert.doesNotMatch(html, /<a(?:\s|>)|data-href|\shref=/iu, href);
		}
	});

	it('does not dispatch relative Markdown resource links', () => {
		const html = renderMarkdown('[Read next](next.md) and [Lab](labs/example.ipynb)');
		assert.match(html, /Read next/u);
		assert.match(html, /Lab/u);
		assert.doesNotMatch(html, /<a(?:\s|>)|data-href|\shref=/iu);
	});

	it('rejects userinfo and repaired URL forms after HTML entity decoding', () => {
		for (const href of [
			'https://user:password@example.com', 'https://user@example.com', 'https://@example.com',
			'https://good.example@evil.example', 'https://example.com\\evil',
			'https://example.com/has space', 'https://example.com/&#9;tab',
			'https://example.com/&#13;return', 'https://example.com/&#x7f;delete',
			'https:///missing-host', 'https://', `https://example.com/${'a'.repeat(4096)}`
		]) {
			assert.doesNotMatch(renderMarkdown(`<a href="${href}">Label</a>`), /<a(?:\s|>)|data-href/iu, href.slice(0, 120));
		}
	});

	it('removes all images and remotely loaded media', () => {
		const html = renderMarkdown('![Remote](https://example.com/pixel.png)\n\n![Local](local.png)\n\n' +
			'<img src="data:image/png;base64,abc" onerror="attack()">' +
			'<picture><source srcset="https://example.com/pixel.png"><img src="https://example.com/x"></picture>' +
			'<video src="https://example.com/movie"><source src="https://example.com/x"></video>' +
			'<audio src="https://example.com/audio"></audio>');
		assert.doesNotMatch(html, /<(?:img|picture|source|video|audio)\b|\ssrc(?:set)?=|onerror/iu);
	});

	it('removes scripts, styles, frames, embeds, SVG, MathML, and document metadata', () => {
		const html = renderMarkdown('<script src="https://example.com/x">attack()</script>' +
			'<style>@import "https://example.com/x";</style>' +
			'<iframe src="https://example.com" srcdoc="attack">hidden frame</iframe>' +
			'<object data="https://example.com/x">hidden object</object><embed src="https://example.com/x">' +
			'<svg onload="attack()"><a xlink:href="javascript:attack()">text</a></svg>' +
			'<math><mtext>math</mtext></math><base href="https://example.com">' +
			'<link rel="stylesheet" href="https://example.com/x"><meta http-equiv="refresh" content="0;url=https://example.com">');
		assert.doesNotMatch(html, /<(?:script|style|iframe|object|embed|svg|math|base|link|meta)\b/iu);
		assert.doesNotMatch(html, /attack|@import|hidden frame|hidden object|xlink:href|\ssrc=/iu);
	});

	it('strips handlers, inline styles, IDs, names, and arbitrary classes', () => {
		const html = renderMarkdown('<div id="action-status" name="vscode" class="actions" style="color:red" onclick="attack()" data-action="reset">Safe</div>' +
			'<h2 id="lesson-heading" onmouseover="attack()">Heading</h2>' +
			'<code class="language-js injected" style="background:url(https://example.com)">x</code>');
		assert.match(html, /<div>Safe<\/div>/u);
		assert.match(html, /<h2>Heading<\/h2>/u);
		assert.match(html, /<code class="language-js">x<\/code>/u);
		assert.doesNotMatch(html, /\s(?:id|name|style|on\w+|data-action)=|injected/iu);
	});

	it('cannot forge action controls or pre-authorized data-href links', () => {
		const html = renderMarkdown('<form action="command:bad"><button data-action="reset">Reset</button>' +
			'<input autofocus onfocus="attack()"></form>' +
			'<a data-href="https://evil.example" role="link" tabindex="0">Fake</a>' +
			'<a href="local.md" data-href="https://evil.example">Also fake</a>');
		assert.doesNotMatch(html, /<(?:form|button|input|a)\b|data-action|data-href|autofocus|onfocus/iu);
		assert.match(html, /Reset/u);
		assert.match(html, /Fake/u);
	});

	it('replaces authored link attributes with only host-managed attributes', () => {
		const html = renderMarkdown('<a href="https://example.com" data-href="https://evil.example" target="_blank" download ping="https://evil.example" onclick="attack()">Visit</a>');
		assert.match(html, /data-href="https:\/\/example\.com"/u);
		assert.doesNotMatch(html, /evil\.example|target=|download|ping=|onclick|\shref=/iu);
	});

	it('escapes hostile link titles without creating attributes', () => {
		const html = renderMarkdown('<a href="https://example.com" title="&quot; onfocus=&quot;attack()&quot;">Visit</a>');
		assert.match(html, /title="&quot; onfocus=&quot;attack\(\)&quot; — Open/u);
		assert.doesNotMatch(html, /\sonfocus="/iu);
	});

	it('keeps fenced and inline HTML examples as text', () => {
		const html = renderMarkdown('`<img src=x onerror=attack()>`\n\n```html\n<script>attack()</script>\n```');
		assert.match(html, /&lt;img/u);
		assert.match(html, /&lt;script&gt;attack\(\)&lt;\/script&gt;/u);
		assert.doesNotMatch(html, /<(?:script|img)\b/iu);
	});

	it('handles malformed hostile markup without retaining active elements', () => {
		const html = renderMarkdown('<details><summary>Open</summary><div><scr<script>ipt>attack()</scr<script>ipt>' +
			'<a href="javascript:attack()"><strong>Label</a></details><img/src="https://example.com" onerror="attack()">');
		assert.doesNotMatch(html, /<(?:script|img)\b|\sonerror=|data-href="javascript:/iu);
		assert.match(html, /Open/u);
	});

	it('preserves bounded numeric ordered-list starts, not arbitrary attributes', () => {
		assert.match(renderMarkdown('<ol start="3"><li>Third</li></ol>'), /<ol start="3">/u);
		for (const start of ['999999999999999', 'not-a-number', '1.2']) {
			assert.doesNotMatch(renderMarkdown(`<ol start="${start}"><li>Item</li></ol>`), /\sstart=/u);
		}
	});

	it('supports an empty lesson without invented content', () => {
		assert.equal(renderMarkdown(''), '');
	});
});

describe('UI progress presentation', () => {
	function fixture(): { course: Course; progress: Progress } {
		const course: Course = {
			id: 'root-bound-hash', root: '/unused',
			manifest: {
				format: 'cert-learner', schemaVersion: 1, courseId: 'portable-id', title: 'Course', contentVersion: '2',
				units: [{
					unitId: 'unit', displayNumber: '03B', title: 'Unit', resources: { lesson: 'lesson.md' },
					activities: [
						{ activityId: 'a', title: 'Read', objectives: [] },
						{ activityId: 'b', title: 'Practice', objectives: [] }
					]
				}]
			}
		};
		const progress: Progress = {
			schemaVersion: 1, courseId: course.id, contentVersion: '1', revision: 0,
			completions: {
				[activityKey('unit', 'a')]: { completedAt: '2026-09-06T10:00:00Z', source: 'manual' },
				[activityKey('removed', 'old')]: { completedAt: '2026-09-05T10:00:00Z', source: 'verified' }
			}
		};
		return { course, progress };
	}

	it('binds progress to the root hash, never the portable course ID', () => {
		const { course, progress } = fixture();
		assert.equal(boundProgress(course, progress), progress);
		assert.equal(boundProgress(course, { ...progress, courseId: course.manifest.courseId }), undefined);
		assert.equal(boundProgress(course, { ...progress, courseId: 'another-root' }), undefined);
		assert.deepEqual(completionSummary(course, { ...progress, courseId: 'another-root' }), { completed: 0, total: 2 });
	});

	it('counts only current activities, retaining old-version records without inventing exam scores', () => {
		const { course, progress } = fixture();
		assert.deepEqual(completionSummary(course, progress), { completed: 1, total: 2 });
		assert.deepEqual(completionSummary(course, progress, course.manifest.units[0]), { completed: 1, total: 2 });
		assert.equal(progress.contentVersion, '1');
		assert.equal(Object.keys(progress.completions).length, 2);
	});

	it('distinguishes manual, locally verified, imported, and unspecified completion', () => {
		const completedAt = '2026-09-06T10:00:00Z';
		assert.equal(activityStatus({ completedAt, source: 'manual' }).icon, 'check');
		assert.equal(activityStatus({ completedAt, source: 'verified' }).icon, 'verified');
		assert.match(activityStatus({ completedAt, source: 'imported' }).label, /not locally verified/u);
		assert.match(activityStatus({ completedAt }).label, /source unspecified/u);
	});

	it('requires an explicit completion timestamp even with a passed result or verified source', () => {
		assert.equal(activityStatus({ lastResult: 'passed', source: 'verified' }).label, 'Not complete');
		assert.equal(activityStatus(undefined).icon, 'circle-outline');
		assert.equal(activityStatus({ lastResult: 'failed' }).tone, 'danger');
		assert.equal(activityStatus({ lastResult: 'blocked' }).tone, 'warning');
	});

	it('preserves authored display numbers and activity order', () => {
		const { course } = fixture();
		const unit = course.manifest.units[0];
		assert.equal(unitLabel(unit), '03B · Unit');
		assert.equal(activityLabel(unit, unit.activities[1]), '03B.2 · Practice');
	});
});