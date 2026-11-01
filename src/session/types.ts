// Minimal rrweb event model. We keep our own types so bugprint has no runtime
// dependency on the recorder and accepts recordings from any rrweb version >= 1.

export const EventType = {
  DomContentLoaded: 0,
  Load: 1,
  FullSnapshot: 2,
  IncrementalSnapshot: 3,
  Meta: 4,
  Custom: 5,
  Plugin: 6,
} as const;

export const IncrementalSource = {
  Mutation: 0,
  MouseMove: 1,
  MouseInteraction: 2,
  Scroll: 3,
  ViewportResize: 4,
  Input: 5,
  TouchMove: 6,
  MediaInteraction: 7,
  Log: 11,
} as const;

export const MouseInteraction = {
  MouseUp: 0,
  MouseDown: 1,
  Click: 2,
  ContextMenu: 3,
  DblClick: 4,
  Focus: 5,
  Blur: 6,
  TouchStart: 7,
  TouchEnd: 9,
} as const;

export const NodeType = {
  Document: 0,
  DocumentType: 1,
  Element: 2,
  Text: 3,
  CDATA: 4,
  Comment: 5,
} as const;

export interface SerializedNode {
  type: number;
  id: number;
  tagName?: string;
  attributes?: Record<string, string | number | boolean | null>;
  childNodes?: SerializedNode[];
  textContent?: string;
  isSVG?: boolean;
  isStyle?: boolean;
}

export interface RrwebEvent {
  type: number;
  timestamp: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

export interface MutationData {
  source: 0;
  adds: { parentId: number; nextId: number | null; node: SerializedNode }[];
  removes: { parentId: number; id: number }[];
  texts: { id: number; value: string | null }[];
  attributes: { id: number; attributes: Record<string, string | null | Record<string, unknown>> }[];
}
