import {
	App,
	Component,
	MarkdownPostProcessorContext,
	MarkdownRenderer,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	TFile,
	addIcon,
	setIcon,
} from "obsidian";
import { MERMAID_ICON_SVG } from "./icon";

/** Custom "Draw a Mermaid" icon (designed by yaye.work), tinted via currentColor. */
const MERMAID_ICON_ID = "draw-a-mermaid";

type Shape = "rect" | "round" | "diamond" | "circle";
type Dir = "TD" | "LR";

interface GNode {
	id: string;
	label: string;
	shape: Shape;
	x: number;
	y: number;
	el?: HTMLElement;
	labelEl?: HTMLElement;
}
interface GEdge {
	id: string;
	from: string;
	to: string;
	label: string;
}
interface Graph {
	dir: Dir;
	nodes: GNode[];
	edges: GEdge[];
}

const SHAPE_OPEN: Record<Shape, string> = {
	rect: "[",
	round: "(",
	diamond: "{",
	circle: "((",
};
const SHAPE_CLOSE: Record<Shape, string> = {
	rect: "]",
	round: ")",
	diamond: "}",
	circle: "))",
};

export default class MermaidVisualPlugin extends Plugin {
	async onload() {
		addIcon(MERMAID_ICON_ID, MERMAID_ICON_SVG);

		this.registerMarkdownPostProcessor((el, ctx) =>
			this.decorateMermaidBlocks(el, ctx)
		);

		// Left ribbon quick-access: open the visual editor on a fresh diagram.
		this.addRibbonIcon(MERMAID_ICON_ID, "Draw a Mermaid", () =>
			this.openBlankEditor()
		);

		this.addCommand({
			id: "edit-mermaid-at-cursor",
			name: "Edit mermaid diagram at cursor",
			editorCheckCallback: (checking, editor, view) => {
				const block = findFenceAroundLine(
					editor.getValue(),
					editor.getCursor().line
				);
				if (!block) return false;
				if (checking) return true;
				new VisualEditorModal(this.app, block.code, async (next) => {
					editor.replaceRange(
						next,
						{ line: block.innerStart, ch: 0 },
						{
							line: block.innerEnd,
							ch: editor.getLine(block.innerEnd).length,
						}
					);
				}).open();
				return true;
			},
		});

		this.addCommand({
			id: "insert-mermaid",
			name: "Insert mermaid diagram (visual editor)",
			editorCallback: (editor) => {
				new VisualEditorModal(this.app, "", async (next) => {
					editor.replaceSelection("```mermaid\n" + next + "\n```\n");
				}).open();
			},
		});
	}

	/** Open a blank visual editor; on save, drop the diagram into the active
	 *  note at the cursor, or create a new note if none is open. */
	private openBlankEditor() {
		new VisualEditorModal(this.app, "", async (next) => {
			const block = "```mermaid\n" + next + "\n```\n";
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view?.editor) {
				view.editor.replaceSelection(block);
			} else {
				const stamp = new Date()
					.toISOString()
					.slice(0, 19)
					.replace("T", " ")
					.replace(/:/g, "");
				const file = await this.app.vault.create(
					`Mermaid diagram ${stamp}.md`,
					block
				);
				await this.app.workspace.getLeaf(true).openFile(file);
			}
		}).open();
	}

	private decorateMermaidBlocks(
		el: HTMLElement,
		ctx: MarkdownPostProcessorContext
	) {
		const blocks = el.querySelectorAll<HTMLElement>(
			".mermaid, pre.mermaid, code.language-mermaid"
		);
		blocks.forEach((blockEl) => {
			const container =
				(blockEl.closest(".el-pre, .markdown-rendered > *") as HTMLElement) ||
				(blockEl.parentElement as HTMLElement) ||
				blockEl;
			if (container.dataset.mvDecorated === "1") return;
			container.dataset.mvDecorated = "1";
			container.classList.add("mv-block");

			const btn = container.createDiv({ cls: "mv-edit-btn" });
			setIcon(btn, "pencil");
			btn.setAttr("aria-label", "Edit diagram visually");
			btn.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				void this.openForRenderedBlock(container, ctx);
			});
		});
	}

	private async openForRenderedBlock(
		container: HTMLElement,
		ctx: MarkdownPostProcessorContext
	) {
		const section = ctx.getSectionInfo(container);
		const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
		if (!section || !(file instanceof TFile)) {
			new Notice("Mermaid Visual: couldn't locate the source block.");
			return;
		}
		const content = await this.app.vault.read(file);
		const lines = content.split("\n");
		const block = parseFence(lines, section.lineStart, section.lineEnd);
		if (!block) {
			new Notice("Mermaid Visual: couldn't parse the mermaid block.");
			return;
		}
		new VisualEditorModal(this.app, block.code, async (next) => {
			const updated = [...lines];
			updated.splice(
				block.innerStart,
				block.innerEnd - block.innerStart + 1,
				...next.split("\n")
			);
			await this.app.vault.modify(file, updated.join("\n"));
		}).open();
	}
}

/* ------------------------------------------------------------------ */
/* Fence helpers (locating the block in the note)                      */
/* ------------------------------------------------------------------ */

interface FenceBlock {
	code: string;
	innerStart: number;
	innerEnd: number;
}

function parseFence(
	lines: string[],
	lineStart: number,
	lineEnd: number
): FenceBlock | null {
	let open = -1;
	for (let i = lineStart; i <= lineEnd && i < lines.length; i++) {
		if (/^\s*(```|~~~)\s*mermaid\s*$/i.test(lines[i])) {
			open = i;
			break;
		}
	}
	if (open === -1) return null;
	let close = -1;
	for (let i = open + 1; i <= lineEnd + 1 && i < lines.length; i++) {
		if (/^\s*(```|~~~)\s*$/.test(lines[i])) {
			close = i;
			break;
		}
	}
	if (close === -1) return null;
	const innerStart = open + 1;
	const innerEnd = close - 1;
	if (innerEnd < innerStart)
		return { code: "", innerStart, innerEnd: innerStart - 1 };
	return {
		code: lines.slice(innerStart, innerEnd + 1).join("\n"),
		innerStart,
		innerEnd,
	};
}

function findFenceAroundLine(
	text: string,
	cursorLine: number
): FenceBlock | null {
	const lines = text.split("\n");
	let open = -1;
	for (let i = cursorLine; i >= 0; i--) {
		if (/^\s*(```|~~~)\s*$/.test(lines[i]) && i !== cursorLine) return null;
		if (/^\s*(```|~~~)\s*mermaid\s*$/i.test(lines[i])) {
			open = i;
			break;
		}
	}
	if (open === -1) return null;
	let close = -1;
	for (let i = open + 1; i < lines.length; i++) {
		if (/^\s*(```|~~~)\s*$/.test(lines[i])) {
			close = i;
			break;
		}
	}
	if (close === -1 || cursorLine >= close) return null;
	const innerStart = open + 1;
	const innerEnd = close - 1;
	return {
		code:
			innerEnd >= innerStart
				? lines.slice(innerStart, innerEnd + 1).join("\n")
				: "",
		innerStart,
		innerEnd: Math.max(innerEnd, innerStart),
	};
}

/* ------------------------------------------------------------------ */
/* Mermaid <-> graph model                                             */
/* ------------------------------------------------------------------ */

function generateMermaid(g: Graph): string {
	const lines: string[] = [`flowchart ${g.dir}`];
	for (const n of g.nodes) {
		const open = SHAPE_OPEN[n.shape];
		const close = SHAPE_CLOSE[n.shape];
		lines.push(`    ${n.id}${open}"${escapeLabel(n.label)}"${close}`);
	}
	for (const e of g.edges) {
		const lbl = e.label.trim()
			? `-->|"${escapeLabel(e.label)}"|`
			: `-->`;
		lines.push(`    ${e.from} ${lbl} ${e.to}`);
	}
	// Persisted layout (ignored by mermaid as a comment).
	const layout: Record<string, [number, number]> = {};
	for (const n of g.nodes) layout[n.id] = [Math.round(n.x), Math.round(n.y)];
	lines.push(`    %% mv:${JSON.stringify(layout)}`);
	return lines.join("\n");
}

function escapeLabel(s: string): string {
	return s.replace(/"/g, "&quot;");
}
function unescapeLabel(s: string): string {
	return s.replace(/&quot;/g, '"');
}

function parseMermaid(code: string): Graph | null {
	const g: Graph = { dir: "TD", nodes: [], edges: [], };
	const nodeMap = new Map<string, GNode>();
	let edgeSeq = 0;
	let layout: Record<string, [number, number]> = {};
	let sawAny = false;

	const ensure = (id: string): GNode => {
		let n = nodeMap.get(id);
		if (!n) {
			n = { id, label: id, shape: "rect", x: 0, y: 0 };
			nodeMap.set(id, n);
			g.nodes.push(n);
		}
		return n;
	};

	const nodeDef = (raw: string): GNode | null => {
		// id["label"] / id("label") / id{"label"} / id(("label"))
		const m = raw.match(
			/^([A-Za-z0-9_]+)\s*(\(\(|\[|\(|\{)\s*"?(.*?)"?\s*(\)\)|\]|\)|\})\s*$/
		);
		if (!m) return null;
		const [, id, open, label] = m;
		const shape: Shape =
			open === "[" ? "rect"
			: open === "(" ? "round"
			: open === "((" ? "circle"
			: "diamond";
		const n = ensure(id);
		n.shape = shape;
		n.label = unescapeLabel(label);
		return n;
	};

	for (const rawLine of code.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;

		const layoutMatch = line.match(/^%%\s*mv:(\{.*\})\s*$/);
		if (layoutMatch) {
			try {
				layout = JSON.parse(layoutMatch[1]) as Record<
					string,
					[number, number]
				>;
			} catch {
				/* ignore */
			}
			continue;
		}
		if (line.startsWith("%%")) continue;

		const header = line.match(/^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)\b/i);
		if (header) {
			const d = header[1].toUpperCase();
			g.dir = d === "LR" || d === "RL" ? "LR" : "TD";
			sawAny = true;
			continue;
		}

		// Edge: <endpoint> --(text)--> <endpoint>
		const edge = line.match(
			/^(.+?)\s*--+>?\s*(?:\|\s*"?(.*?)"?\s*\|\s*)?(.+?)\s*$/
		);
		const isEdge = /--+>/.test(line);
		if (isEdge && edge) {
			const fromRaw = edge[1].trim();
			const label = edge[2] ?? "";
			const toRaw = edge[3].trim();
			const from = nodeDef(fromRaw) ?? ensure(idOnly(fromRaw));
			const to = nodeDef(toRaw) ?? ensure(idOnly(toRaw));
			g.edges.push({
				id: `e${edgeSeq++}`,
				from: from.id,
				to: to.id,
				label: unescapeLabel(label),
			});
			sawAny = true;
			continue;
		}

		// Standalone node def
		const nd = nodeDef(line);
		if (nd) {
			sawAny = true;
			continue;
		}
		// Bare id reference
		if (/^[A-Za-z0-9_]+$/.test(line)) {
			ensure(line);
			sawAny = true;
		}
	}

	if (!sawAny || g.nodes.length === 0) return null;

	// Apply saved layout, or auto-place anything missing one.
	let auto = 0;
	for (const n of g.nodes) {
		const p = layout[n.id];
		if (p && Array.isArray(p)) {
			n.x = p[0];
			n.y = p[1];
		} else {
			n.x = 80 + (auto % 3) * 200;
			n.y = 80 + Math.floor(auto / 3) * 130;
			auto++;
		}
	}
	return g;
}

function idOnly(raw: string): string {
	const m = raw.match(/^([A-Za-z0-9_]+)/);
	return m ? m[1] : raw.replace(/[^A-Za-z0-9_]/g, "") || "n";
}

/** Shortest distance from point (px,py) to the segment (x1,y1)-(x2,y2). */
function distToSegment(
	px: number,
	py: number,
	x1: number,
	y1: number,
	x2: number,
	y2: number
): number {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const len2 = dx * dx + dy * dy;
	let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
	t = Math.max(0, Math.min(1, t));
	const cx = x1 + t * dx;
	const cy = y1 + t * dy;
	return Math.hypot(px - cx, py - cy);
}

/* ------------------------------------------------------------------ */
/* Small text-input modal for connector labels                         */
/* ------------------------------------------------------------------ */

class EdgeLabelModal extends Modal {
	private value: string;
	private onSubmit: (value: string) => void;

	constructor(app: App, value: string, onSubmit: (value: string) => void) {
		super(app);
		this.value = value;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "Connector label" });
		const input = contentEl.createEl("input", {
			type: "text",
			cls: "mv-label-input",
			value: this.value,
		});
		input.placeholder = "(leave blank for no label)";
		const commit = () => {
			this.onSubmit(input.value);
			this.close();
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				commit();
			} else if (e.key === "Escape") {
				this.close();
			}
		});
		const footer = contentEl.createDiv({ cls: "mv-footer" });
		const ok = footer.createEl("button", { text: "OK", cls: "mod-cta" });
		ok.addEventListener("click", commit);
		const cancel = footer.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());
		input.focus();
		input.select();
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* ------------------------------------------------------------------ */
/* The visual editor modal                                             */
/* ------------------------------------------------------------------ */

class VisualEditorModal extends Modal {
	private onSave: (code: string) => Promise<void>;
	private g: Graph;
	private idSeq = 1;
	private selectedNodes = new Set<string>();
	private selectedEdge: string | null = null;
	private hoverEdge: string | null = null; // edge to splice into on drop

	private canvasEl!: HTMLElement;
	private nodesLayer!: HTMLElement;
	private edgesSvg!: SVGSVGElement;
	private codeEl!: HTMLElement;
	private previewEl!: HTMLElement;
	private renderComp: Component;
	private renderSeq = 0;
	private renderTimer: number | null = null;

	private shapeButtons = new Map<Shape, HTMLButtonElement>();

	private drag:
		| {
				kind: "pending";
				id: string;
				dx: number;
				dy: number;
				sx: number;
				sy: number;
				pointerId: number;
				alt: boolean;
		  }
		| {
				kind: "move";
				ids: string[];
				startX: number;
				startY: number;
				starts: Map<string, { x: number; y: number }>;
		  }
		| { kind: "edge"; from: string; line: SVGLineElement }
		| {
				kind: "marquee";
				el: HTMLElement;
				sx: number;
				sy: number;
				base: Set<string>;
		  }
		| null = null;

	constructor(app: App, code: string, onSave: (code: string) => Promise<void>) {
		super(app);
		this.onSave = onSave;
		this.renderComp = new Component();
		const parsed = code.trim() ? parseMermaid(code) : null;
		this.g = parsed ?? { dir: "TD", nodes: [], edges: [] };
		// keep id sequence above existing numeric ids
		for (const n of this.g.nodes) {
			const m = n.id.match(/^n(\d+)$/);
			if (m) this.idSeq = Math.max(this.idSeq, Number(m[1]) + 1);
		}
		if (!parsed && code.trim()) {
			// existing block we couldn't parse — warn but let them start fresh
			new Notice(
				"Mermaid Visual: couldn't parse this diagram into blocks; starting a fresh canvas."
			);
		}
	}

	onOpen() {
		this.modalEl.addClass("mv-modal");
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("mv-modal-content");

		this.buildToolbar(contentEl);

		const body = contentEl.createDiv({ cls: "mv-body" });

		// Visual canvas (source of truth)
		const canvasWrap = body.createDiv({ cls: "mv-canvas-wrap" });
		this.canvasEl = canvasWrap.createDiv({ cls: "mv-canvas" });
		this.edgesSvg = this.canvasEl.createSvg("svg", {
			cls: "mv-edges",
		}) as unknown as SVGSVGElement;
		const defs = this.edgesSvg.createSvg("defs");
		const marker = defs.createSvg("marker", {
			attr: {
				id: "mv-arrow",
				viewBox: "0 0 10 10",
				refX: "9",
				refY: "5",
				markerWidth: "7",
				markerHeight: "7",
				orient: "auto-start-reverse",
			},
		});
		marker.createSvg("path", {
			attr: { d: "M 0 0 L 10 5 L 0 10 z", fill: "var(--text-muted)" },
		});
		this.nodesLayer = this.canvasEl.createDiv({ cls: "mv-nodes" });

		// Press on empty canvas → start a rubber-band marquee selection.
		this.canvasEl.addEventListener("pointerdown", (e) => {
			if (e.target !== this.canvasEl && e.target !== this.nodesLayer) return;
			const rect = this.canvasEl.getBoundingClientRect();
			const sx = e.clientX - rect.left + this.canvasEl.scrollLeft;
			const sy = e.clientY - rect.top + this.canvasEl.scrollTop;
			const base = e.shiftKey ? new Set(this.selectedNodes) : new Set<string>();
			if (!e.shiftKey) this.select(null, null);
			const marquee = this.canvasEl.createDiv({ cls: "mv-marquee" });
			marquee.style.left = `${sx}px`;
			marquee.style.top = `${sy}px`;
			this.drag = { kind: "marquee", el: marquee, sx, sy, base };
			this.canvasEl.setPointerCapture(e.pointerId);
		});
		this.canvasEl.addEventListener("pointermove", (e) => this.onPointerMove(e));
		this.canvasEl.addEventListener("pointerup", (e) => this.onPointerUp(e));

		// Output pane: live render on top, generated code below
		const out = body.createDiv({ cls: "mv-out" });
		const pTop = out.createDiv({ cls: "mv-out-section" });
		pTop.createDiv({ cls: "mv-pane-label", text: "Rendered" });
		this.previewEl = pTop.createDiv({ cls: "mv-preview" });
		const pBot = out.createDiv({ cls: "mv-out-section" });
		pBot.createDiv({ cls: "mv-pane-label", text: "Mermaid code" });
		this.codeEl = pBot.createEl("pre", { cls: "mv-code" });

		this.buildFooter(contentEl);

		this.renderComp.load();
		this.rebuildNodes();
		this.refresh();

		// Keyboard: delete the selected block/arrow — but NOT while editing a
		// label, where Backspace/Delete must edit text. Returning undefined
		// lets the keystroke fall through to the contenteditable.
		const onDelete = () => {
			if (this.isEditingLabel()) return;
			this.deleteSelection();
			return false;
		};
		this.scope.register([], "Delete", onDelete);
		this.scope.register([], "Backspace", onDelete);
	}

	private isEditingLabel(): boolean {
		return !!this.contentEl.querySelector(".mv-node-label.is-editing");
	}

	private buildToolbar(parent: HTMLElement) {
		const bar = parent.createDiv({ cls: "mv-toolbar" });

		// Shape picker: with a node selected, changes its shape;
		// with nothing selected, adds a new block of that shape.
		const shapes: { s: Shape; name: string }[] = [
			{ s: "rect", name: "Rectangle" },
			{ s: "round", name: "Rounded" },
			{ s: "diamond", name: "Diamond (decision)" },
			{ s: "circle", name: "Circle" },
		];
		const shapeGroup = bar.createDiv({ cls: "mv-segmented" });
		for (const { s, name } of shapes) {
			const b = shapeGroup.createEl("button", { cls: "mv-seg mv-seg-shape" });
			this.addShapeGlyph(b, s);
			b.setAttr("aria-label", name);
			b.setAttr("title", `${name} — click to add, or reshape selected block(s)`);
			this.shapeButtons.set(s, b);
			b.addEventListener("click", () => {
				if (this.selectedNodes.size) {
					for (const id of this.selectedNodes) {
						const n = this.node(id);
						if (n) {
							n.shape = s;
							this.applyShape(n);
						}
					}
					this.updateShapeButtons();
					this.refresh();
				} else {
					this.createNodeAt(s);
				}
			});
		}

		bar.createSpan({ cls: "mv-sep" });

		// Direction
		const dirGroup = bar.createDiv({ cls: "mv-segmented" });
		const dirTitles: Record<Dir, string> = {
			TD: "Top-Down — diagram flows downward",
			LR: "Left-to-Right — diagram flows across",
		};
		(["TD", "LR"] as Dir[]).forEach((d) => {
			const b = dirGroup.createEl("button", { cls: "mv-seg", text: d });
			b.setAttr("title", dirTitles[d]);
			if (d === this.g.dir) b.addClass("is-active");
			b.addEventListener("click", () => {
				this.g.dir = d;
				dirGroup
					.querySelectorAll(".mv-seg")
					.forEach((x) => x.removeClass("is-active"));
				b.addClass("is-active");
				this.refresh();
			});
		});

		bar.createSpan({ cls: "mv-sep" });
		const del = bar.createEl("button", { cls: "mv-tool", text: "Delete" });
		del.addEventListener("click", () => this.deleteSelection());

		bar.createSpan({
			cls: "mv-hint",
			text: "Click a shape to add · drag ● to connect · ⌥-drag to duplicate",
		});
	}

	private buildFooter(parent: HTMLElement) {
		const footer = parent.createDiv({ cls: "mv-footer" });
		const save = footer.createEl("button", { text: "Save", cls: "mod-cta" });
		save.addEventListener("click", () => {
			void (async () => {
				try {
					await this.onSave(generateMermaid(this.g));
					new Notice("Diagram saved.");
					this.close();
				} catch (err) {
					console.error("Draw a Mermaid save failed", err);
					new Notice("Draw a Mermaid: save failed (see console).");
				}
			})();
		});
		const cancel = footer.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());
	}

	/* ---- model helpers ---- */
	private node(id: string): GNode | undefined {
		return this.g.nodes.find((n) => n.id === id);
	}

	/** Create a node. With no coords it lands near the canvas centre. */
	private createNodeAt(shape: Shape, x?: number, y?: number): GNode {
		const id = `n${this.idSeq++}`;
		if (x === undefined || y === undefined) {
			const rect = this.canvasEl.getBoundingClientRect();
			const offset = (this.g.nodes.length % 5) * 24;
			x = this.canvasEl.scrollLeft + rect.width / 2 - 50 + offset;
			y = this.canvasEl.scrollTop + rect.height / 2 - 20 + offset;
		}
		const n: GNode = { id, label: "New block", shape, x, y };
		this.g.nodes.push(n);
		this.createNodeEl(n);
		this.select(id, null);
		this.refresh();
		// immediately edit the label
		window.setTimeout(() => this.beginRename(n), 0);
		return n;
	}

	/** Clone a node (same label/shape/position) as a new block, without
	 *  touching selection — caller decides what ends up selected. */
	private makeDuplicate(src: GNode): GNode {
		const id = `n${this.idSeq++}`;
		const n: GNode = {
			id,
			label: src.label,
			shape: src.shape,
			x: src.x,
			y: src.y,
		};
		this.g.nodes.push(n);
		this.createNodeEl(n);
		return n;
	}

	private updateShapeButtons() {
		// Active shape = the shape shared by every selected block (if any).
		const shapes = new Set<Shape>();
		for (const id of this.selectedNodes) {
			const n = this.node(id);
			if (n) shapes.add(n.shape);
		}
		const common = shapes.size === 1 ? [...shapes][0] : null;
		this.shapeButtons.forEach((btn, shape) => {
			btn.toggleClass("is-active", common === shape);
		});
	}

	private deleteSelection() {
		if (this.selectedNodes.size) {
			const ids = this.selectedNodes;
			this.g.nodes = this.g.nodes.filter((n) => {
				if (ids.has(n.id)) {
					n.el?.remove();
					return false;
				}
				return true;
			});
			this.g.edges = this.g.edges.filter(
				(e) => !ids.has(e.from) && !ids.has(e.to)
			);
			this.select(null, null);
			this.refresh();
		} else if (this.selectedEdge) {
			this.g.edges = this.g.edges.filter((e) => e.id !== this.selectedEdge);
			this.select(null, null);
			this.refresh();
		}
	}

	/** Select a single node (or none) plus an optional edge. */
	private select(node: string | null, edge: string | null) {
		this.selectedNodes.clear();
		if (node) this.selectedNodes.add(node);
		this.selectedEdge = edge;
		this.applySelection();
	}

	/** Replace the multi-node selection (clears any edge selection). */
	private setSelection(ids: Iterable<string>) {
		this.selectedNodes = new Set(ids);
		this.selectedEdge = null;
		this.applySelection();
	}

	/** Reflect the current selection state in the DOM. */
	private applySelection() {
		this.nodesLayer
			.querySelectorAll(".mv-node")
			.forEach((el) =>
				el.toggleClass(
					"is-selected",
					this.selectedNodes.has((el as HTMLElement).dataset.id || "")
				)
			);
		this.updateShapeButtons();
		this.drawEdges();
	}

	/* ---- DOM: nodes ---- */
	private rebuildNodes() {
		this.nodesLayer.empty();
		for (const n of this.g.nodes) this.createNodeEl(n);
	}

	private createNodeEl(n: GNode) {
		const el = this.nodesLayer.createDiv({ cls: "mv-node" });
		el.dataset.id = n.id;
		n.el = el;
		const label = el.createDiv({ cls: "mv-node-label", text: n.label });
		n.labelEl = label;
		const handle = el.createDiv({ cls: "mv-handle" });
		handle.setAttr("aria-label", "Drag to connect");

		this.applyShape(n);
		this.positionNode(n);

		// select; arm a *pending* move that only becomes a real drag past a
		// small threshold. Capturing the pointer on every click would hijack
		// the dblclick target and break re-editing, so we defer capture.
		el.addEventListener("pointerdown", (e) => {
			if ((e.target as HTMLElement).closest(".mv-handle")) return;
			if (label.isContentEditable) return;
			e.stopPropagation();
			if (e.shiftKey) {
				// toggle membership; no drag
				if (this.selectedNodes.has(n.id)) this.selectedNodes.delete(n.id);
				else this.selectedNodes.add(n.id);
				this.selectedEdge = null;
				this.applySelection();
				return;
			}
			// If pressing an unselected block, select just it. If it's already
			// part of a multi-selection, keep the selection so we can drag the group.
			if (!this.selectedNodes.has(n.id)) this.select(n.id, null);
			this.drag = {
				kind: "pending",
				id: n.id,
				dx: 0,
				dy: 0,
				sx: e.clientX,
				sy: e.clientY,
				pointerId: e.pointerId,
				alt: e.altKey,
			};
		});
		el.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			this.beginRename(n);
		});

		// connect drag
		handle.addEventListener("pointerdown", (e) => {
			e.stopPropagation();
			e.preventDefault();
			const line = this.edgesSvg.createSvg("line", {
				cls: "mv-temp-edge",
				attr: { "marker-end": "url(#mv-arrow)" },
			}) as unknown as SVGLineElement;
			this.drag = { kind: "edge", from: n.id, line };
			this.canvasEl.setPointerCapture(e.pointerId);
		});
	}

	private applyShape(n: GNode) {
		if (!n.el) return;
		n.el.removeClass("shape-rect", "shape-round", "shape-diamond", "shape-circle");
		n.el.addClass(`shape-${n.shape}`);
	}

	/** Draw a matching line-style glyph for a shape-picker button. */
	private addShapeGlyph(btn: HTMLElement, shape: Shape) {
		const svg = btn.createSvg("svg", {
			attr: {
				viewBox: "0 0 24 24",
				width: "16",
				height: "16",
				fill: "none",
				stroke: "currentColor",
				"stroke-width": "2",
				"stroke-linecap": "round",
				"stroke-linejoin": "round",
			},
		});
		if (shape === "rect") {
			svg.createSvg("rect", {
				attr: { x: "3.5", y: "7", width: "17", height: "10" },
			});
		} else if (shape === "round") {
			svg.createSvg("rect", {
				attr: { x: "3.5", y: "7", width: "17", height: "10", rx: "3.5" },
			});
		} else if (shape === "diamond") {
			svg.createSvg("path", { attr: { d: "M12 3 L21 12 L12 21 L3 12 Z" } });
		} else {
			svg.createSvg("circle", { attr: { cx: "12", cy: "12", r: "8.5" } });
		}
	}

	private positionNode(n: GNode) {
		if (!n.el) return;
		n.el.style.left = `${n.x}px`;
		n.el.style.top = `${n.y}px`;
	}

	private beginRename(n: GNode) {
		const label = n.labelEl;
		if (!label) return;
		label.contentEditable = "true";
		label.addClass("is-editing");
		label.focus();
		// select all
		const range = activeDocument.createRange();
		range.selectNodeContents(label);
		const sel = activeWindow.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);

		const finish = () => {
			label.contentEditable = "false";
			label.removeClass("is-editing");
			n.label = (label.textContent || "").trim() || "Block";
			label.textContent = n.label;
			label.removeEventListener("blur", finish);
			label.removeEventListener("keydown", onKey);
			this.refresh();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Enter") {
				e.preventDefault();
				label.blur();
			} else if (e.key === "Escape") {
				label.textContent = n.label;
				label.blur();
			}
			e.stopPropagation();
		};
		label.addEventListener("blur", finish);
		label.addEventListener("keydown", onKey);
		label.addEventListener("input", () => {
			n.label = label.textContent || "";
			this.drawEdges();
			this.scheduleOutput();
		});
	}

	/* ---- pointer drag handling ---- */
	private onPointerMove(e: PointerEvent) {
		if (!this.drag) return;
		const rect = this.canvasEl.getBoundingClientRect();
		const x = e.clientX - rect.left + this.canvasEl.scrollLeft;
		const y = e.clientY - rect.top + this.canvasEl.scrollTop;
		if (this.drag.kind === "pending") {
			const moved =
				Math.abs(e.clientX - this.drag.sx) +
				Math.abs(e.clientY - this.drag.sy);
			if (moved < 4) return; // still a click, not a drag

			// The whole selection moves together (the pressed block is included).
			let ids = [...this.selectedNodes];
			if (ids.length === 0) ids = [this.drag.id];

			// Alt/Option-drag duplicates the selection and drags the copies.
			if (this.drag.alt) {
				const dups: string[] = [];
				for (const oid of ids) {
					const o = this.node(oid);
					if (o) dups.push(this.makeDuplicate(o).id);
				}
				if (dups.length) {
					ids = dups;
					this.setSelection(dups);
				}
			}

			const starts = new Map<string, { x: number; y: number }>();
			for (const id of ids) {
				const n = this.node(id);
				if (n) starts.set(id, { x: n.x, y: n.y });
			}
			this.canvasEl.setPointerCapture(this.drag.pointerId);
			this.drag = { kind: "move", ids, startX: x, startY: y, starts };
		}
		if (this.drag.kind === "move") {
			const dxp = x - this.drag.startX;
			const dyp = y - this.drag.startY;
			for (const id of this.drag.ids) {
				const n = this.node(id);
				const s = this.drag.starts.get(id);
				if (!n || !s) continue;
				n.x = s.x + dxp;
				n.y = s.y + dyp;
				this.positionNode(n);
			}
			// Splice-into-arrow only makes sense for a single dragged block.
			this.hoverEdge =
				this.drag.ids.length === 1
					? this.findEdgeNear(x, y, this.drag.ids[0])
					: null;
			this.drawEdges();
		} else if (this.drag.kind === "marquee") {
			const minX = Math.min(this.drag.sx, x);
			const minY = Math.min(this.drag.sy, y);
			const w = Math.abs(x - this.drag.sx);
			const h = Math.abs(y - this.drag.sy);
			this.drag.el.style.left = `${minX}px`;
			this.drag.el.style.top = `${minY}px`;
			this.drag.el.style.width = `${w}px`;
			this.drag.el.style.height = `${h}px`;
			const sel = new Set(this.drag.base);
			for (const n of this.g.nodes) {
				if (!n.el) continue;
				const nx2 = n.x + n.el.offsetWidth;
				const ny2 = n.y + n.el.offsetHeight;
				const hit = n.x < minX + w && nx2 > minX && n.y < minY + h && ny2 > minY;
				if (hit) sel.add(n.id);
			}
			this.selectedNodes = sel;
			this.applySelection();
		} else if (this.drag.kind === "edge") {
			const from = this.node(this.drag.from);
			if (!from || !from.el) return;
			const c = this.nodeCenter(from);
			this.drag.line.setAttrs({
				x1: String(c.x),
				y1: String(c.y),
				x2: String(x),
				y2: String(y),
			});
		}
	}

	private onPointerUp(e: PointerEvent) {
		if (!this.drag) return;
		if (this.drag.kind === "edge") {
			this.drag.line.remove();
			const target = activeDocument
				.elementFromPoint(e.clientX, e.clientY)
				?.closest(".mv-node") as HTMLElement | null;
			const fromId = this.drag.from;
			let toId = target?.dataset.id;

			// Dropped on empty canvas → spawn a new rectangle block there.
			if (!toId) {
				const rect = this.canvasEl.getBoundingClientRect();
				const x = e.clientX - rect.left + this.canvasEl.scrollLeft - 50;
				const y = e.clientY - rect.top + this.canvasEl.scrollTop - 20;
				const created = this.createNodeAt("rect", x, y);
				toId = created.id;
			}

			if (toId && toId !== fromId) {
				const dup = this.g.edges.some(
					(ed) => ed.from === fromId && ed.to === toId
				);
				if (!dup) {
					this.g.edges.push({
						id: `e${Date.now()}`,
						from: fromId,
						to: toId,
						label: "",
					});
				}
			}
			this.refresh();
		} else if (this.drag.kind === "move") {
			// A single block dropped onto an arrow splices into that connection.
			if (this.hoverEdge && this.drag.ids.length === 1) {
				this.spliceIntoEdge(this.hoverEdge, this.drag.ids[0]);
			}
			this.hoverEdge = null;
			this.refresh();
		} else if (this.drag.kind === "marquee") {
			this.drag.el.remove();
		}
		// "pending" with no movement was just a click — nothing to finalise.
		this.drag = null;
	}

	/* ---- edges drawing ---- */
	private nodeCenter(n: GNode): { x: number; y: number; w: number; h: number } {
		const el = n.el!;
		return {
			x: n.x + el.offsetWidth / 2,
			y: n.y + el.offsetHeight / 2,
			w: el.offsetWidth,
			h: el.offsetHeight,
		};
	}

	private borderPoint(
		from: { x: number; y: number; w: number; h: number },
		to: { x: number; y: number }
	): { x: number; y: number } {
		const dx = to.x - from.x;
		const dy = to.y - from.y;
		if (dx === 0 && dy === 0) return { x: from.x, y: from.y };
		const hw = from.w / 2 + 2;
		const hh = from.h / 2 + 2;
		const scale = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
		return { x: from.x + dx * scale, y: from.y + dy * scale };
	}

	/** Border-to-border endpoints of an edge, or null if a node is missing. */
	private edgeEndpoints(
		e: GEdge
	): { p1: { x: number; y: number }; p2: { x: number; y: number } } | null {
		const a = this.node(e.from);
		const b = this.node(e.to);
		if (!a?.el || !b?.el) return null;
		const ca = this.nodeCenter(a);
		const cb = this.nodeCenter(b);
		return { p1: this.borderPoint(ca, cb), p2: this.borderPoint(cb, ca) };
	}

	/** Nearest edge whose line passes within ~14px of (x,y), excluding edges
	 *  already touching the given node. Used for drop-to-splice. */
	private findEdgeNear(x: number, y: number, excludeNode: string): string | null {
		let best: string | null = null;
		let bestDist = 14;
		for (const e of this.g.edges) {
			if (e.from === excludeNode || e.to === excludeNode) continue;
			const ends = this.edgeEndpoints(e);
			if (!ends) continue;
			const d = distToSegment(x, y, ends.p1.x, ends.p1.y, ends.p2.x, ends.p2.y);
			if (d < bestDist) {
				bestDist = d;
				best = e.id;
			}
		}
		return best;
	}

	/** Insert `nodeId` into edge `edgeId`: F→T becomes F→node→T. */
	private spliceIntoEdge(edgeId: string, nodeId: string) {
		const e = this.g.edges.find((x) => x.id === edgeId);
		if (!e || e.from === nodeId || e.to === nodeId) return;
		const from = e.from;
		const to = e.to;
		const label = e.label;
		this.g.edges = this.g.edges.filter((x) => x.id !== edgeId);
		const has = (f: string, t: string) =>
			this.g.edges.some((x) => x.from === f && x.to === t);
		if (!has(from, nodeId))
			this.g.edges.push({ id: `e${Date.now()}a`, from, to: nodeId, label });
		if (!has(nodeId, to))
			this.g.edges.push({ id: `e${Date.now()}b`, from: nodeId, to, label: "" });
	}

	private drawEdges() {
		// remove existing drawn edges (keep defs)
		this.edgesSvg
			.querySelectorAll(".mv-edge-group, .mv-edge-hit, .mv-edge-line, .mv-edge-label")
			.forEach((n) => n.remove());

		for (const e of this.g.edges) {
			const ends = this.edgeEndpoints(e);
			if (!ends) continue;
			const p1 = ends.p1;
			const p2 = ends.p2;

			// fat invisible hit line for easy selection
			const hit = this.edgesSvg.createSvg("line", { cls: "mv-edge-hit" });
			hit.setAttrs({
				x1: String(p1.x),
				y1: String(p1.y),
				x2: String(p2.x),
				y2: String(p2.y),
			});
			hit.addEventListener("pointerdown", (ev) => {
				ev.stopPropagation();
				this.select(null, e.id);
			});
			hit.addEventListener("dblclick", (ev) => {
				ev.stopPropagation();
				new EdgeLabelModal(this.app, e.label, (next) => {
					e.label = next;
					this.refresh();
				}).open();
			});

			const line = this.edgesSvg.createSvg("line", {
				cls: "mv-edge-line",
				attr: { "marker-end": "url(#mv-arrow)" },
			});
			line.setAttrs({
				x1: String(p1.x),
				y1: String(p1.y),
				x2: String(p2.x),
				y2: String(p2.y),
			});
			if (e.id === this.selectedEdge) line.addClass("is-selected");
			if (e.id === this.hoverEdge) line.addClass("is-drop-target");

			if (e.label.trim()) {
				const mx = (p1.x + p2.x) / 2;
				const my = (p1.y + p2.y) / 2;
				const t = this.edgesSvg.createSvg("text", {
					cls: "mv-edge-label",
				});
				t.textContent = e.label;
				t.setAttrs({ x: String(mx), y: String(my - 4) });
			}
		}
	}

	/* ---- output (code + render) ---- */
	private refresh() {
		this.drawEdges();
		this.scheduleOutput();
	}

	private scheduleOutput() {
		const code = generateMermaid(this.g);
		this.codeEl.setText(code);
		if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
		this.renderTimer = window.setTimeout(() => {
			void this.renderPreview(code);
		}, 200);
	}

	private async renderPreview(code: string) {
		const seq = ++this.renderSeq;
		const target = createDiv();
		try {
			await MarkdownRenderer.render(
				this.app,
				"```mermaid\n" + code + "\n```",
				target,
				"",
				this.renderComp
			);
		} catch (err) {
			target.empty();
			target.createDiv({
				cls: "mv-error",
				text: err instanceof Error ? err.message : String(err),
			});
		}
		if (seq !== this.renderSeq) return;
		this.previewEl.empty();
		this.previewEl.append(...Array.from(target.childNodes));
	}

	onClose() {
		if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
		this.renderComp.unload();
		this.contentEl.empty();
	}
}
