import type MarkdownItType from 'markdown-it' with { 'resolution-mode': 'import' };
import sanitizeHtml from 'sanitize-html';
import { safeHttps } from '../core/course';

// markdown-it 15's CJS declaration re-exports ESM types without resolution-mode.
// Resolve its public ESM types explicitly; keep the bundled CJS runtime in Node16.
const MarkdownIt = require('markdown-it') as typeof MarkdownItType;
const markdown = new MarkdownIt({ html: true, linkify: false, typographer: false });

/**
 * Render untrusted course content without executable or remotely loaded content.
 * HTTPS links are deliberately inert: the panel host must confirm data-href links.
 * No VS Code runtime is required by this module.
 */
export function renderMarkdown(source: string): string {
	return sanitizeHtml(markdown.render(source), {
		allowedTags: [
			'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote',
			'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'strong', 'em', 'b', 'i', 's', 'del',
			'code', 'pre', 'kbd', 'samp', 'sup', 'sub', 'a', 'span', 'div',
			'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
			'details', 'summary', 'figure', 'figcaption'
		],
		allowedAttributes: {
			a: ['data-href', 'role', 'tabindex', 'title'],
			code: ['class'],
			details: ['open'],
			ol: ['start']
		},
		allowedClasses: { code: [/^language-[a-z0-9_-]+$/iu] },
		allowedSchemes: ['https'],
		allowProtocolRelative: false,
		disallowedTagsMode: 'discard',
		nonTextTags: ['script', 'style', 'textarea', 'option', 'iframe', 'object', 'noscript', 'template'],
		transformTags: {
			a: (_tag, attributes): sanitizeHtml.Tag => {
				const href = attributes.href;
				if (!href || !safeHttps(href)) { return { tagName: 'span', attribs: {} }; }
				return {
					tagName: 'a',
					attribs: {
						'data-href': href,
						role: 'link',
						tabindex: '0',
						title: `${attributes.title ? `${attributes.title} — ` : ''}Open ${new URL(href).hostname} (confirmation required)`
					}
				};
			},
			ol: (_tag, attributes): sanitizeHtml.Tag => ({
				tagName: 'ol',
				attribs: /^-?\d{1,5}$/u.test(attributes.start ?? '') ? { start: attributes.start } : {}
			})
		}
	});
}