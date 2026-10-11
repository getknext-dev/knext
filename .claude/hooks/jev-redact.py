#!/usr/bin/env python3
"""Reduce a shell command to a REDACTED SKELETON: intent stays visible, literals do not.

    printf '%s' "$cmd" | python3 jev-redact.py     # skeleton on stdout, exit 0
                                                    # exit 1, no output: could not build one

WHY. jev-bash-gate.sh asks a third party what a command is meant to do. Sending the command
verbatim ships whatever literals it carries (passwords in `-p`, userinfo in a URL, a token in
an assignment). A denylist of "looks like a credential" cannot be complete, so the gate sends
THIS instead: command names, subcommands, bare flags, paths and operators survive; every
literal VALUE becomes `<V>`.

WHAT SURVIVES (so a destructive intent is still readable):
  command names, bare flags, operators (; && || | & > < ( )), paths (/x, ./x, ~/x, a/b),
  `$VAR`, plain letters-only positional words (`origin main`, `FLUSHALL`), URLs minus their
  userinfo and query values, and the INNER string of `bash -c '...'`, `sh -c`, `zsh -c`,
  `eval '...'`, `ssh host '...'` (redacted recursively, so `bash -c 'rm -rf /data'` stays
  readable while `bash -c 'mysql -pSECRET'` becomes `bash -c 'mysql -p<V>'`).

WHAT BECOMES <V>: quoted strings, the value after `=` (assignments, `--flag=v`, `k=v`) unless it
is a path, the word after a flag that takes a value, short-flag attached values (`-pXXX`,
`-uXXX`), URL userinfo, comments, heredoc bodies, any word that is not plainly an identifier or
a path (digits, colons, ...), and any 20+ char alphanumeric run that mixes digits or cases.

BEST EFFORT, NOT A PROOF. Residual, stated: a letters-only word that is a password and follows
no flag (`echo correcthorse | sudo -S ...`) is kept, and a flag this script wrongly believes is
boolean leaves its argument visible if that argument is a plain word. The denylist in
jev-hook-lib.sh stays the first line of defence and the backstop. An unbalanced quote or any
parse failure exits 1: the gate then sends NOTHING.

Python 3.8+ (macOS ships 3.9). Stdlib only.
"""
import re
import sys

PH = "<V>"
MAX_DEPTH = 4

SHELLS = {"bash", "sh", "zsh", "dash", "ksh", "ash"}
# Words after which the NEXT word is again a command (so env assignments / names are read right).
WRAPPERS = {"sudo", "env", "xargs", "time", "nohup", "nice", "exec", "command", "doas",
            "builtin", "then", "do", "else", "elif", "if", "while", "until", "!", "{",
            "watch", "timeout"}

# Long flags that take NO value, so the word after them is a subcommand/positional (kept).
BOOL_LONG = {"force", "force-with-lease", "recursive", "verbose", "help", "version", "quiet",
             "yes", "dry-run", "hard", "soft", "delete", "all", "prune", "rm", "interactive",
             "tty", "detach", "follow", "purge", "cascade", "ignore-not-found", "wait", "global",
             "amend", "oneline", "stat", "short", "bare", "mirror", "tags", "no-edit", "silent",
             "show-error", "location", "insecure", "fail", "compressed", "include", "head"}
BOOL_SHORT = set("rRfvViIqyxsSLkAhzjJtT")
# Single-dash multi-letter words that are NOT `-X<attached value>`; value = takes an argument.
KNOWN_DASH = {
    "-name": True, "-iname": True, "-type": True, "-mtime": True, "-mmin": True, "-atime": True,
    "-ctime": True, "-size": True, "-path": True, "-ipath": True, "-perm": True, "-user": True,
    "-group": True, "-newer": True, "-maxdepth": True, "-mindepth": True, "-regex": True,
    "-links": True,
    "-delete": False, "-print": False, "-print0": False, "-printf": True, "-exec": False,
    "-ok": False, "-prune": False, "-empty": False, "-not": False, "-and": False, "-or": False,
    "-depth": False, "-quit": False, "-xdev": False, "-mount": False,
    "-rf": False, "-fr": False, "-rfv": False, "-rv": False, "-xzvf": False, "-czvf": False,
    "-xvf": False, "-tvf": False, "-la": False, "-lah": False, "-al": False, "-ltr": False,
    "-lh": False, "-it": False, "-ti": False, "-aux": False,
}
ATTACHED_VALUE = re.compile(r"^-([pPuUaAwWkK])(.+)$")

PATH_ABS = re.compile(r"^(~|\.{1,2}|/\S*|\.{1,2}/\S*|~/\S*)$")
PATH_REL = re.compile(r"^[A-Za-z0-9._+-]+(/[A-Za-z0-9._+-]+)+/?$")
CMD_RE = re.compile(r"^[A-Za-z0-9._+/~:\[\]{}!-]{1,64}$")
PLAIN = re.compile(r"^[A-Za-z][A-Za-z_.-]{0,40}$")
VAR_ONLY = re.compile(r"^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?(/[A-Za-z0-9._{}$-]*)*$")
ASSIGN = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)(\+?=)(.*)$", re.S)
KV = re.compile(r"^([A-Za-z0-9_.-]+)=(.*)$", re.S)
URL = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*://")
ENTROPY = re.compile(r"[A-Za-z0-9]{20,}")
FD_REDIR = re.compile(r"\d*(>>|>&|>\||>|<<<|<<-|<<|<&|<>|<)")
BARE_OP = re.compile(r"&>>|&>|;;|;|&&|\|\||\|&|\||&|\(|\)")


class Unparseable(Exception):
    pass


# ── lexing ────────────────────────────────────────────────────────────────────────────────
def skip_paren(s, k):
    """s[k] == '(' -> index just past the matching ')', quote- and nesting-aware."""
    depth, n = 0, len(s)
    while k < n:
        c = s[k]
        if c == "\\":
            k += 2
            continue
        if c == "'":
            e = s.find("'", k + 1)
            if e < 0:
                raise Unparseable("unterminated ' in $()")
            k = e + 1
            continue
        if c == '"':
            k = find_dq_end(s, k) + 1
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return k + 1
        k += 1
    raise Unparseable("unbalanced $(")


def find_dq_end(s, j):
    """s[j] == '"' -> index of the closing quote."""
    k, n = j + 1, len(s)
    while k < n:
        c = s[k]
        if c == "\\":
            k += 2
            continue
        if c == "$" and s[k + 1:k + 2] == "(":
            k = skip_paren(s, k + 1)
            continue
        if c == "`":
            e = s.find("`", k + 1)
            if e < 0:
                raise Unparseable("unterminated `")
            k = e + 1
            continue
        if c == '"':
            return k
        k += 1
    raise Unparseable('unterminated "')


class Word:
    def __init__(self, parts):
        self.parts = parts  # [(kind, text)] kind: lit | sq | dq | sub | bt
        self.raw = "".join(self.render(p) for p in parts)

    @staticmethod
    def render(p):
        kind, text = p
        if kind == "sq":
            return "'" + text + "'"
        if kind == "dq":
            return '"' + text + '"'
        return text

    def is_lit(self):
        return all(k == "lit" for k, _ in self.parts)

    def pure(self, kind):
        return len(self.parts) == 1 and self.parts[0][0] == kind


def scan_word(s, i):
    n, j, buf, parts = len(s), i, [], []

    def flush():
        if buf:
            parts.append(("lit", "".join(buf)))
            del buf[:]

    while j < n:
        c = s[j]
        if c in " \t\n;&|<>()":
            break
        if c == "\\":
            if j + 1 >= n:
                raise Unparseable("trailing backslash")
            buf.append(s[j:j + 2])
            j += 2
        elif c == "'":
            e = s.find("'", j + 1)
            if e < 0:
                raise Unparseable("unterminated '")
            flush()
            parts.append(("sq", s[j + 1:e]))
            j = e + 1
        elif c == '"':
            e = find_dq_end(s, j)
            flush()
            parts.append(("dq", s[j + 1:e]))
            j = e + 1
        elif c == "$" and s[j + 1:j + 2] == "(":
            e = skip_paren(s, j + 1)
            flush()
            parts.append(("sub", s[j:e]))
            j = e
        elif c == "$" and s[j + 1:j + 2] == "{":
            e = s.find("}", j)
            if e < 0:
                raise Unparseable("unterminated ${")
            buf.append(s[j:e + 1])
            j = e + 1
        elif c == "`":
            e = s.find("`", j + 1)
            if e < 0:
                raise Unparseable("unterminated `")
            flush()
            parts.append(("bt", s[j:e + 1]))
            j = e + 1
        else:
            buf.append(c)
            j += 1
    flush()
    if not parts:
        raise Unparseable("empty word")
    return Word(parts), j


# ── per-simple-command state ──────────────────────────────────────────────────────────────
class State:
    def __init__(self):
        self.reset()

    def reset(self):
        self.cmd_pos = True
        self.pending_value = False   # previous word was a flag that takes a value
        self.redirect = False        # previous token was a redirect operator
        self.shell_inner = False     # previous word was `-c` of a shell
        self.last_plain = ""
        self.seen = set()


# ── rules (each is one named, mutation-provable decision) ─────────────────────────────────
def scrub_entropy(text):
    """RULE entropy: long mixed alphanumeric runs are tokens, even in a kept path/URL."""
    def sub(m):
        t = m.group(0)
        if re.search(r"[0-9]", t) or (re.search(r"[a-z]", t) and re.search(r"[A-Z]", t)):
            return PH
        return t
    return ENTROPY.sub(sub, text)


def is_path(raw):
    return bool(PATH_ABS.match(raw) or PATH_REL.match(raw))


def redact_url(raw):
    """RULE url: drop userinfo and query/fragment values, keep scheme, host and path."""
    out = re.sub(r"^([A-Za-z][A-Za-z0-9+.-]*://)[^/?#]*@", r"\1" + PH + "@", raw)
    out = re.sub(r"([?&])([^=&#]*)=([^&#]*)", lambda m: m.group(1) + m.group(2) + "=" + PH, out)
    out = re.sub(r"#.*$", "#" + PH, out)
    return scrub_entropy(out)


def redact_value(value):
    """The right-hand side of `=`: a path survives, anything else is a literal."""
    if URL.match(value):
        return redact_url(value)
    if is_path(value):  # RULE path: keep paths (`of=/dev/sda`)
        return scrub_entropy(value)
    return PH


def inner(word, depth):
    """RULE recursion: redact the INNER string of bash -c / eval / ssh '...' instead of
    replacing it whole, so destructive intent inside stays readable."""
    kind, text = word.parts[0]
    if kind == "dq":
        text = re.sub(r"\\([\"\\$`])", r"\1", text)
    q = "'" if kind == "sq" else '"'
    return q + redact(text, depth + 1) + q


def cmdsub(raw, depth):
    """RULE substitution: redact INSIDE `$( ... )`, keep its shape."""
    return "$(" + redact(raw[2:-1], depth + 1) + ")"


def redact_quoted(word):
    """RULE quoted: a quoted string is a literal, unless it is a path."""
    kind, text = word.parts[0]
    if is_path(text):
        return word.raw
    return PH


def redact_arg(w, st, depth):
    """A non-command-position word."""
    raw = w.raw

    # ssh / eval: a quoted argument is a command string -> recurse (RULE recursion)
    if w.parts[0][0] in ("sq", "dq") and len(w.parts) == 1 and ("ssh" in st.seen or "eval" in st.seen):
        return inner(w, depth)

    # command substitution standing alone: redact inside it, keep the shape
    if len(w.parts) == 1 and w.parts[0][0] == "sub":
        return cmdsub(raw, depth)
    if len(w.parts) == 1 and w.parts[0][0] == "bt":
        return "`" + redact(raw[1:-1], depth + 1) + "`"

    if len(w.parts) == 1 and w.parts[0][0] in ("sq", "dq"):
        return redact_quoted(w)
    if not w.is_lit():
        # `--flag="v"` style: keep the name, redact the value
        m = re.match(r"^(-{1,2}[A-Za-z0-9_.-]+)=(.*)$", raw, re.S)
        if m:
            return m.group(1) + "=" + PH
        return PH

    # ---- flags ----------------------------------------------------------------------------
    if raw == "--":
        return raw
    if raw.startswith("--") and len(raw) > 2:
        if "=" in raw:  # RULE =value: `--flag=value`
            name, value = raw.split("=", 1)
            return name + "=" + redact_value(value)
        name = raw[2:]
        st.pending_value = not (name in BOOL_LONG or name.startswith("no-"))
        return raw
    if raw.startswith("-") and len(raw) > 1 and not raw[1].isdigit():
        if re.fullmatch(r"-[A-Za-z]*c", raw) and st.last_plain in SHELLS:
            st.shell_inner = True  # RULE recursion: `bash -c '...'`
            return raw
        if raw in KNOWN_DASH:
            st.pending_value = KNOWN_DASH[raw]
            return raw
        m = ATTACHED_VALUE.match(raw)
        if m:  # RULE attached: `-pSECRET`, `-uroot`
            return "-" + m.group(1) + PH
        st.pending_value = len(raw) == 2 and raw[1] not in BOOL_SHORT
        return raw
    if raw.startswith("-") and len(raw) > 1:  # `-5` and friends
        st.pending_value = False
        return raw

    # ---- a value or a positional word -----------------------------------------------------
    if st.pending_value:  # RULE flag-value: the word after a flag that takes a value
        st.pending_value = False
        if URL.match(raw):
            return redact_url(raw)
        return scrub_entropy(raw) if is_path(raw) else PH

    kv = KV.match(raw)
    if kv:  # RULE =value: `k=v`, `of=/dev/sda`, `--set a.b=c`
        return kv.group(1) + "=" + redact_value(kv.group(2))
    if URL.match(raw):
        return redact_url(raw)
    if is_path(raw):
        return scrub_entropy(raw)
    if VAR_ONLY.match(raw):
        return raw
    if PLAIN.match(raw):
        # letters-only mixed-case runs of 12+ look like generated tokens
        if len(raw) >= 12 and re.search(r"[a-z]", raw[1:]) and re.search(r"[A-Z]", raw[1:]):
            return PH
        st.last_plain = raw.rsplit("/", 1)[-1]
        st.seen.add(st.last_plain)
        return raw
    return PH


def redact_command_word(w, st, depth):
    """The first word of a simple command, or an env assignment before it."""
    raw = w.raw
    if len(w.parts) == 1 and w.parts[0][0] == "sub":
        st.cmd_pos = False
        return cmdsub(raw, depth)
    if not w.is_lit():
        st.cmd_pos = False
        return PH
    a = ASSIGN.match(raw)
    if a:  # RULE =value: `FOO=secret cmd`, `export`-less assignment
        return a.group(1) + a.group(2) + redact_value(a.group(3))
    st.cmd_pos = False
    if CMD_RE.match(raw):
        base = raw.rsplit("/", 1)[-1]
        st.last_plain = base
        st.seen.add(base)
        if base in WRAPPERS:
            st.cmd_pos = True
        return scrub_entropy(raw)
    return PH


# ── main walk ─────────────────────────────────────────────────────────────────────────────
def redact(s, depth=0):
    if depth > MAX_DEPTH:
        raise Unparseable("nesting too deep")
    s = s.replace("\\\n", " ")
    n, i = len(s), 0
    out, st = [], State()
    heredocs = []        # (delimiter, strip_tabs) waiting for their body
    want_delim = None    # strip_tabs flag while the next word is a heredoc delimiter

    while i < n:
        c = s[i]
        if c in " \t":
            j = i
            while j < n and s[j] in " \t":
                j += 1
            out.append(s[i:j])
            i = j
            continue
        if c == "\n":
            out.append("\n")
            i += 1
            st.reset()
            for delim, strip in heredocs:
                body_start = i
                while True:
                    if i >= n:
                        raise Unparseable("heredoc without terminator")
                    e = s.find("\n", i)
                    line = s[i:e if e >= 0 else n]
                    nxt = (e + 1) if e >= 0 else n
                    if (line.lstrip("\t") if strip else line) == delim:
                        out.append((PH + "\n" if i > body_start else "") + line + ("\n" if e >= 0 else ""))
                        i = nxt
                        break
                    i = nxt
            heredocs = []
            continue
        if c == "#" and (not out or out[-1][-1:] in (" ", "\t", "\n", ";", "&", "|", "(", ")")):
            e = s.find("\n", i)
            out.append("#" + PH)  # RULE comment
            i = n if e < 0 else e
            continue

        m = FD_REDIR.match(s, i)
        if m:
            op = m.group(0)
            out.append(op)
            i = m.end()
            if m.group(1) in ("<<", "<<-"):
                want_delim = m.group(1) == "<<-"
            elif m.group(1) != "<<<":
                st.redirect = True
            continue
        m = BARE_OP.match(s, i)
        if m:
            out.append(m.group(0))
            i = m.end()
            st.reset()
            continue

        w, i = scan_word(s, i)
        if want_delim is not None:
            delim = "".join(t for _, t in w.parts)
            heredocs.append((delim, want_delim))
            want_delim = None
            out.append(w.raw)
            continue
        if st.redirect:
            st.redirect = False
            if w.is_lit() and (re.fullmatch(r"\d{1,2}|-", w.raw) or is_path(w.raw) or PLAIN.match(w.raw)):
                out.append(scrub_entropy(w.raw))
            else:
                out.append(PH)
            continue
        if st.shell_inner:
            st.shell_inner = False
            if len(w.parts) == 1 and w.parts[0][0] in ("sq", "dq"):
                out.append(inner(w, depth))
                continue
        if st.cmd_pos:
            out.append(redact_command_word(w, st, depth))
        else:
            out.append(redact_arg(w, st, depth))

    if heredocs or want_delim is not None:
        raise Unparseable("heredoc without body")
    return "".join(out)


def main():
    try:
        sys.stdout.write(redact(sys.stdin.read()))
        return 0
    except Exception:  # Unparseable or anything unforeseen: the caller sends nothing
        return 1


if __name__ == "__main__":
    sys.exit(main())
