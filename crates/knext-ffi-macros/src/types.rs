//! Classification of Rust types against the type table (README, ADR-0069 D6),
//! the canonical type token used in `sig` and in record schemas, and the
//! manifest type descriptor.

use proc_macro2::TokenStream;
use quote::{quote, ToTokens};
use syn::{spanned::Spanned, Error, GenericArgument, PathArguments, Type};

/// Appended to every rejection so the error points at the table.
pub const TABLE_HINT: &str =
    "supported types are listed in the knext-ffi type table (ADR-0069 D6, crates/README.md)";

/// Where a type appears. The same Rust type crosses differently by position:
/// `Vec<u8>` is raw bytes at the top level and a JSON number array inside JSON.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Pos {
    Arg,
    Ret,
    Json,
}

#[derive(Clone)]
pub enum Desc {
    /// i8 … usize, f32, f64, bool
    Scalar(&'static str),
    Str,
    /// top-level `Vec<u8>` / `&[u8]` only
    Bytes,
    Unit,
    /// a `#[knext_ffi::record]` struct or unit enum, as written at the use site
    Named(Box<Type>, String),
    Option(Box<Desc>),
    Vec(Box<Desc>),
}

/// How a top-level argument is lowered into the shim's parameters.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Value,
    StrRef,
    StrOwned,
    BytesRef,
    BytesOwned,
    Json,
    Unit,
}

pub fn pretty(ty: &impl ToTokens) -> String {
    let s = ty.to_token_stream().to_string();
    let mut s = s
        .replace(" :: ", "::")
        .replace(":: ", "::")
        .replace(" < ", "<")
        .replace("< ", "<")
        .replace(" <", "<")
        .replace(" >", ">")
        .replace(" ,", ",")
        .replace("& ", "&")
        .replace("' ", "'")
        .replace(" ;", ";")
        .replace("( ", "(")
        .replace(" )", ")")
        .replace("[ ", "[")
        .replace(" ]", "]")
        .replace("* const ", "*const ")
        .replace("* mut ", "*mut ")
        .replace(" : ", ": ");
    if s.starts_with("& '") {
        s = s.replacen("& '", "&'", 1);
    }
    s
}

pub fn reject(span: &impl Spanned, ty: &impl ToTokens, why: &str) -> Error {
    Error::new(
        span.span(),
        format!(
            "knext-ffi: `{}` is not supported: {why}; {TABLE_HINT}",
            pretty(ty)
        ),
    )
}

fn unwrap_group(ty: &Type) -> &Type {
    match ty {
        Type::Group(g) => unwrap_group(&g.elem),
        Type::Paren(p) => unwrap_group(&p.elem),
        other => other,
    }
}

fn single_type_arg(args: &PathArguments) -> Option<&Type> {
    if let PathArguments::AngleBracketed(a) = args {
        if a.args.len() == 1 {
            if let GenericArgument::Type(t) = &a.args[0] {
                return Some(t);
            }
        }
    }
    None
}

pub fn is_u8(ty: &Type) -> bool {
    matches!(unwrap_group(ty), Type::Path(p) if p.qself.is_none() && p.path.is_ident("u8"))
}

const SCALARS: [&str; 13] = [
    "i8", "i16", "i32", "i64", "isize", "u8", "u16", "u32", "u64", "usize", "f32", "f64", "bool",
];

/// Classifies `ty` at `pos`, or explains why the table rejects it.
pub fn classify(ty: &Type, pos: Pos) -> Result<(Desc, Mode), Error> {
    let t = unwrap_group(ty);
    match t {
        Type::Tuple(tt) if tt.elems.is_empty() => {
            return match pos {
                Pos::Ret => Ok((Desc::Unit, Mode::Unit)),
                Pos::Arg => Err(reject(ty, ty, "`()` is only valid as a return type")),
                Pos::Json => Err(reject(
                    ty,
                    ty,
                    "`()` cannot appear inside a record, Option or Vec",
                )),
            };
        }
        Type::Tuple(_) => {
            return Err(reject(
                ty,
                ty,
                "tuples cannot cross the boundary; use a #[knext_ffi::record] struct",
            ))
        }
        Type::Reference(r) => {
            if pos == Pos::Ret {
                return Err(reject(
                    ty,
                    ty,
                    "returning a reference is not supported; return an owned `String` or `Vec<u8>`",
                ));
            }
            if pos == Pos::Json {
                return Err(reject(ty, ty, "references cannot appear inside a record, Option or Vec; use `String` or `Vec<u8>`"));
            }
            if r.mutability.is_some() {
                return Err(reject(
                    ty,
                    ty,
                    "`&mut` references are not supported; only `&str` and `&[u8]` are",
                ));
            }
            if r.lifetime.is_some() {
                return Err(reject(ty, ty, "write the reference without a lifetime (`&str`, `&[u8]`): it is borrowed for the call only"));
            }
            let elem = unwrap_group(&r.elem);
            if let Type::Path(p) = elem {
                if p.qself.is_none() && p.path.is_ident("str") {
                    return Ok((Desc::Str, Mode::StrRef));
                }
            }
            if let Type::Slice(s) = elem {
                if is_u8(&s.elem) {
                    return Ok((Desc::Bytes, Mode::BytesRef));
                }
            }
            return Err(reject(
                ty,
                ty,
                "the only supported references are `&str` and `&[u8]`",
            ));
        }
        Type::Ptr(_) => return Err(reject(ty, ty, "raw pointers are not supported")),
        Type::ImplTrait(_) => return Err(reject(ty, ty, "`impl Trait` is not supported")),
        Type::TraitObject(_) => return Err(reject(ty, ty, "trait objects are not supported")),
        Type::Array(_) => {
            return Err(reject(
                ty,
                ty,
                "fixed-size arrays are not supported; use `Vec<T>`",
            ))
        }
        Type::Slice(_) => {
            return Err(reject(
                ty,
                ty,
                "unsized slices are not supported; use `&[u8]` or `Vec<T>`",
            ))
        }
        Type::FnPtr(_) => {
            return Err(reject(
                ty,
                ty,
                "function pointers and callbacks are not supported",
            ))
        }
        Type::Never(_) => return Err(reject(ty, ty, "the never type is not supported")),
        Type::Path(_) => {}
        _ => return Err(reject(ty, ty, "this kind of type is not supported")),
    }
    let Type::Path(tp) = t else { unreachable!() };
    if tp.qself.is_some() {
        return Err(reject(
            ty,
            ty,
            "qualified paths (`<T as Trait>::X`) are not supported",
        ));
    }
    let seg = tp.path.segments.last().expect("a path has a last segment");
    let name = seg.ident.to_string();
    let no_args = matches!(seg.arguments, PathArguments::None);

    if no_args {
        if let Some(s) = SCALARS.iter().find(|s| **s == name) {
            return Ok((Desc::Scalar(s), Mode::Value).json_if(pos));
        }
        match name.as_str() {
            "char" => {
                return Err(reject(
                    ty,
                    ty,
                    "`char` has no TypeScript equivalent; pass a `String` or a `u32` code point",
                ))
            }
            "i128" | "u128" => {
                return Err(reject(
                    ty,
                    ty,
                    "128-bit integers are not supported; use `i64`/`u64` or a decimal `String`",
                ))
            }
            "str" => return Err(reject(ty, ty, "`str` must be borrowed as `&str`")),
            "String" => {
                let mode = if pos == Pos::Arg {
                    Mode::StrOwned
                } else {
                    Mode::Value
                };
                return Ok((Desc::Str, if pos == Pos::Json { Mode::Json } else { mode }));
            }
            "Self" => {
                return Err(reject(
                    ty,
                    ty,
                    "`Self` is not supported; methods cannot be exported",
                ))
            }
            _ => {}
        }
        let ident = seg.ident.to_string();
        let bare = ident.strip_prefix("r#").unwrap_or(&ident).to_string();
        return Ok((Desc::Named(Box::new(ty.clone()), bare), Mode::Json));
    }

    match name.as_str() {
        "Vec" => {
            let Some(inner) = single_type_arg(&seg.arguments) else {
                return Err(reject(ty, ty, "write `Vec<T>` with exactly one type argument"));
            };
            if is_u8(inner) && pos != Pos::Json {
                let mode = if pos == Pos::Arg { Mode::BytesOwned } else { Mode::Value };
                return Ok((Desc::Bytes, mode));
            }
            let (d, _) = classify(inner, Pos::Json)?;
            Ok((Desc::Vec(Box::new(d)), Mode::Json))
        }
        "Option" => {
            let Some(inner) = single_type_arg(&seg.arguments) else {
                return Err(reject(ty, ty, "write `Option<T>` with exactly one type argument"));
            };
            let (d, _) = classify(inner, Pos::Json)?;
            if matches!(d, Desc::Option(_)) {
                // Both `None` and `Some(None)` are JSON `null`: the outer level
                // cannot survive the round trip, so refuse it rather than lose it.
                return Err(reject(
                    ty,
                    ty,
                    "a nested `Option` cannot cross the boundary: `None` and `Some(None)` are both JSON `null`; use a #[knext_ffi::record] struct or unit enum that names the cases",
                ));
            }
            Ok((Desc::Option(Box::new(d)), Mode::Json))
        }
        "Result" => Err(reject(ty, ty, "`Result<T, E>` is only supported as the return type")),
        _ => Err(reject(
            ty,
            ty,
            "generic types are not supported (only `Option<T>`, `Vec<T>` and a returned `Result<T, E>` take type arguments)",
        )),
    }
}

trait JsonIf {
    fn json_if(self, pos: Pos) -> Self;
}
impl JsonIf for (Desc, Mode) {
    fn json_if(self, pos: Pos) -> Self {
        if pos == Pos::Json {
            (self.0, Mode::Json)
        } else {
            self
        }
    }
}

impl Desc {
    /// The canonical type token (README, "Canonical strings"): the token the
    /// generator derives from the manifest descriptor, so both sides agree.
    pub fn token(&self) -> String {
        match self {
            Desc::Scalar(s) => (*s).to_string(),
            Desc::Str => "string".into(),
            Desc::Bytes => "bytes".into(),
            Desc::Unit => "unit".into(),
            Desc::Named(_, n) => n.clone(),
            Desc::Option(d) => format!("option<{}>", d.token()),
            Desc::Vec(d) => format!("vec<{}>", d.token()),
        }
    }

    /// Every record/enum type this descriptor names, outermost first.
    pub fn named(&self, out: &mut Vec<Type>) {
        match self {
            Desc::Named(t, _) => {
                if !out.iter().any(|o| o == &**t) {
                    out.push((**t).clone());
                }
            }
            Desc::Option(d) | Desc::Vec(d) => d.named(out),
            _ => {}
        }
    }

    /// Whether the descriptor names the type called `name` anywhere.
    pub fn mentions(&self, name: &str) -> bool {
        match self {
            Desc::Named(_, n) => n == name,
            Desc::Option(d) | Desc::Vec(d) => d.mentions(name),
            _ => false,
        }
    }

    /// The manifest type descriptor as a list of pieces: literal JSON text,
    /// and the kind/name of named types read from their `KnextSchema` const
    /// (only the record macro knows whether a name is a struct or an enum).
    pub fn pieces(&self, out: &mut Pieces) {
        match self {
            Desc::Scalar(s) => out.lit(&format!("{{\"t\":\"{s}\"}}")),
            Desc::Str => out.lit("{\"t\":\"string\"}"),
            Desc::Bytes => out.lit("{\"t\":\"bytes\"}"),
            Desc::Unit => out.lit("{\"t\":\"unit\"}"),
            Desc::Named(t, _) => {
                out.lit("{\"t\":\"");
                out.expr(quote!(<#t as ::knext_ffi::__rt::KnextSchema>::SCHEMA.kind));
                out.lit("\",\"name\":\"");
                out.expr(quote!(<#t as ::knext_ffi::__rt::KnextSchema>::SCHEMA.name));
                out.lit("\"}");
            }
            Desc::Option(d) => {
                out.lit("{\"t\":\"option\",\"of\":");
                d.pieces(out);
                out.lit("}");
            }
            Desc::Vec(d) => {
                out.lit("{\"t\":\"vec\",\"of\":");
                d.pieces(out);
                out.lit("}");
            }
        }
    }
}

/// A manifest record under construction: adjacent literals are merged.
#[derive(Default)]
pub struct Pieces(Vec<Piece>);

enum Piece {
    Lit(String),
    Expr(TokenStream),
}

impl Pieces {
    pub fn lit(&mut self, s: &str) {
        if let Some(Piece::Lit(last)) = self.0.last_mut() {
            last.push_str(s);
        } else {
            self.0.push(Piece::Lit(s.to_string()));
        }
    }
    pub fn expr(&mut self, e: TokenStream) {
        self.0.push(Piece::Expr(e));
    }
    pub fn to_tokens(&self) -> Vec<TokenStream> {
        self.0
            .iter()
            .map(|p| match p {
                Piece::Lit(s) => quote!(#s),
                Piece::Expr(e) => e.clone(),
            })
            .collect()
    }
}

/// JSON string literal (with quotes). Control characters, including NUL (the
/// record terminator), are escaped, so a record never contains a raw NUL.
pub fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 || c == '\u{7f}' => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// FNV-1a, 32-bit, over UTF-8 bytes (the `<h>` in a shim's symbol name).
pub fn fnv1a32(s: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in s.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// The `///` doc comment, one leading space stripped per line.
pub fn doc_of(attrs: &[syn::Attribute]) -> String {
    let mut lines = Vec::new();
    for a in attrs {
        if !a.path().is_ident("doc") {
            continue;
        }
        if let syn::Meta::NameValue(nv) = &a.meta {
            if let syn::Expr::Lit(syn::ExprLit {
                lit: syn::Lit::Str(s),
                ..
            }) = &nv.value
            {
                let v = s.value();
                for line in v.split('\n') {
                    lines.push(
                        line.strip_prefix(' ')
                            .unwrap_or(line)
                            .trim_end()
                            .to_string(),
                    );
                }
            }
        }
    }
    lines.join("\n").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tok(src: &str, pos: Pos) -> String {
        let ty: Type = syn::parse_str(src).unwrap();
        classify(&ty, pos)
            .map(|(d, _)| d.token())
            .unwrap_or_else(|e| format!("ERR {e}"))
    }

    #[test]
    fn fnv1a32_matches_the_reference_vectors() {
        assert_eq!(fnv1a32(""), 0x811c9dc5);
        assert_eq!(fnv1a32("a"), 0xe40c292c);
        assert_eq!(fnv1a32("foobar"), 0xbf9cf968);
    }

    #[test]
    fn tokens_follow_the_canonical_grammar() {
        assert_eq!(tok("&str", Pos::Arg), "string");
        assert_eq!(tok("String", Pos::Ret), "string");
        assert_eq!(tok("Vec<u8>", Pos::Arg), "bytes");
        assert_eq!(tok("&[u8]", Pos::Arg), "bytes");
        assert_eq!(tok("Vec<u8>", Pos::Json), "vec<u8>");
        assert_eq!(tok("Option<Vec<u8>>", Pos::Arg), "option<vec<u8>>");
        assert_eq!(tok("Vec<Option<i64>>", Pos::Ret), "vec<option<i64>>");
        assert_eq!(tok("crate::types::Point", Pos::Arg), "Point");
        assert_eq!(tok("std::primitive::u64", Pos::Arg), "u64");
        assert_eq!(tok("()", Pos::Ret), "unit");
    }

    #[test]
    fn rejections_name_the_type_and_the_table() {
        for (src, pos) in [
            ("char", Pos::Arg),
            ("i128", Pos::Ret),
            ("(i32, i32)", Pos::Arg),
            ("&i32", Pos::Arg),
            ("&str", Pos::Ret),
            ("HashMap<String, i32>", Pos::Arg),
            ("Result<i32, String>", Pos::Arg),
            ("Vec<char>", Pos::Arg),
            ("&'a str", Pos::Arg),
        ] {
            let e = tok(src, pos);
            assert!(e.starts_with("ERR knext-ffi: `"), "{src}: {e}");
            assert!(e.contains("D6"), "{src}: {e}");
        }
        assert!(tok("Vec<char>", Pos::Arg).contains("`char`"));
    }

    #[test]
    fn a_nested_option_is_rejected_in_every_position() {
        // `Some(None)` and `None` would both be JSON `null`: silent data loss.
        for (src, pos, named) in [
            ("Option<Option<i32>>", Pos::Arg, "Option<Option<i32>>"),
            ("Option<Option<u64>>", Pos::Ret, "Option<Option<u64>>"),
            ("Option<Option<bool>>", Pos::Json, "Option<Option<bool>>"),
            ("Vec<Option<Option<i64>>>", Pos::Arg, "Option<Option<i64>>"),
            (
                "Option<Vec<Option<Option<String>>>>",
                Pos::Ret,
                "Option<Option<String>>",
            ),
            (
                "Option<std::option::Option<u8>>",
                Pos::Arg,
                "Option<std::option::Option<u8>>",
            ),
            ("Option<(Option<i32>)>", Pos::Arg, "Option<(Option<i32>)>"),
        ] {
            let e = tok(src, pos);
            assert!(
                e.starts_with(&format!("ERR knext-ffi: `{named}` is not supported: ")),
                "{src}: {e}"
            );
            assert!(
                e.contains("nested `Option`") && e.contains("D6"),
                "{src}: {e}"
            );
        }
        // An Option separated from another by a Vec is unambiguous and stays.
        assert_eq!(
            tok("Option<Vec<Option<i32>>>", Pos::Arg),
            "option<vec<option<i32>>>"
        );
        assert_eq!(tok("Vec<Option<i64>>", Pos::Json), "vec<option<i64>>");
    }

    #[test]
    fn json_strings_escape_control_characters_and_nul() {
        assert_eq!(json_str("a\"b\\c\n\0é"), "\"a\\\"b\\\\c\\n\\u0000é\"");
    }
}
