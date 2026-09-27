// Minimal typing for mvdan-sh (the GopherJS build of mvdan.cc/sh/v3/syntax; the package ships no
// types). Only the surface tests/helpers/bun-base-scan.ts reads. Every field is optional because one
// structural interface stands in for all node kinds; the scanner narrows on syntax.NodeType().
declare module 'mvdan-sh' {
  export interface ShPos {
    Offset(): number;
    Line(): number;
  }
  export interface ShNode {
    Pos(): ShPos;
    End(): ShPos;
    Stmts?: ShNode[];
    Cmd?: ShNode | null;
    Redirs?: ShNode[];
    Negated?: boolean;
    Background?: boolean;
    Coprocess?: boolean;
    Args?: ShNode[];
    Assigns?: ShNode[];
    Parts?: ShNode[];
    X?: ShNode;
    Y?: ShNode;
    Op?: number;
    Cond?: ShNode[];
    Then?: ShNode[];
    Else?: ShNode | null;
    Loop?: ShNode;
    Do?: ShNode[];
    Name?: ShNode | null;
    Items?: ShNode[];
    Word?: ShNode | null;
    Patterns?: ShNode[];
    Body?: ShNode;
    Variant?: ShNode;
    Value?: ShNode | string | null;
    Naked?: boolean;
    Index?: ShNode | null;
    Array?: ShNode | null;
    N?: ShNode | null;
    Hdoc?: ShNode | null;
    Dollar?: boolean;
    Param?: ShNode;
    Exp?: ShNode | null;
    Excl?: boolean;
    Names?: number;
  }
  export interface ShParser {
    Parse(src: string, name: string): ShNode;
  }
  export const syntax: {
    NewParser(...opts: unknown[]): ShParser;
    Variant(lang: unknown): unknown;
    LangBash: unknown;
    NodeType(n: ShNode): string;
    Walk(n: ShNode, f: (n: ShNode | null) => boolean): void;
  };
  const sh: { syntax: typeof syntax };
  export default sh;
}
