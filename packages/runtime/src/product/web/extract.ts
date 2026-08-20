import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { type RequestTextOptions, requestText } from "./http.ts";

/** Content types accepted by the built-in bounded page fetcher. */
const SUPPORTED_CONTENT_TYPES = ["text/html", "application/xhtml+xml", "text/plain"];

export interface ExtractedPage {
	url: string;
	title?: string;
	contentType: string;
	markdown: string;
	truncated: boolean;
}

export interface ExtractPageOptions extends RequestTextOptions {
	maxChars: number;
	request?: typeof requestText;
}

function htmlToMarkdown(html: string): string {
	const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
	turndown.use(gfm);
	turndown.addRule("removeEmptyLinks", {
		filter: (node) => node.nodeName === "A" && !node.textContent?.trim(),
		replacement: () => "",
	});
	return turndown
		.turndown(html)
		.replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, "")
		.replace(/[ \t]+/g, " ")
		.replace(/\s+,/g, ",")
		.replace(/\s+\./g, ".")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function extractHtml(html: string, url: string): { title?: string; markdown: string } {
	const dom = new JSDOM(html, { url });
	try {
		const article = new Readability(dom.window.document).parse();
		if (article?.content) {
			return { title: article.title || undefined, markdown: htmlToMarkdown(article.content) };
		}
	} finally {
		dom.window.close();
	}

	const fallback = new JSDOM(html, { url });
	try {
		const document = fallback.window.document;
		document.querySelectorAll("script, style, noscript, nav, header, footer, aside").forEach((element) => {
			element.remove();
		});
		const title = document.querySelector("title")?.textContent?.trim() || undefined;
		const main = document.querySelector("main, article, [role='main'], .content, #content") ?? document.body;
		return { title, markdown: htmlToMarkdown(main?.innerHTML ?? "") };
	} finally {
		fallback.window.close();
	}
}

function normalizedContentType(header: string | string[] | undefined): string {
	const value = Array.isArray(header) ? header[0] : header;
	return value?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
}

export async function extractPage(url: string, options: ExtractPageOptions): Promise<ExtractedPage> {
	const request = options.request ?? requestText;
	const response = await request(url, {
		signal: options.signal,
		timeoutMs: options.timeoutMs,
		maxBytes: options.maxBytes,
		maxRedirects: options.maxRedirects,
		headers: {
			Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
			"Accept-Encoding": "identity",
			"Accept-Language": "en-US,en;q=0.8",
			"User-Agent": "MyPi-WebSearch/0.1 (+https://github.com/badlogic/pi-skills)",
		},
	});
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`HTTP ${response.status} while fetching ${response.url}.`);
	}

	const contentType = normalizedContentType(response.headers["content-type"]);
	if (!SUPPORTED_CONTENT_TYPES.includes(contentType)) {
		throw new Error(`Unsupported content type ${contentType} at ${response.url}.`);
	}

	const extracted =
		contentType === "text/plain" ? { markdown: response.body.trim() } : extractHtml(response.body, response.url);
	if (!extracted.markdown) throw new Error(`Could not extract readable content from ${response.url}.`);

	const truncated = extracted.markdown.length > options.maxChars;
	return {
		url: response.url,
		title: extracted.title,
		contentType,
		markdown: truncated
			? `${extracted.markdown.slice(0, options.maxChars).trimEnd()}\n\n[Content truncated]`
			: extracted.markdown,
		truncated,
	};
}
