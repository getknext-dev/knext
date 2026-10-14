//! `#[knext_ffi::export]`: the `extern "C"` shim, its `_schema` companion and
//! the embedded manifest record (README, "ABI v1"; ADR-0069 D4/D5).

use crate::types::{
    classify, doc_of, fnv1a32, json_str, pretty, Desc, Mode, Pieces, Pos, TABLE_HINT,
};
use proc_macro2::{Span, TokenStream};
use quote::{format_ident, quote};
use syn::{
    spanned::Spanned, Error, FnArg, GenericArgument, ItemFn, Pat, PathArguments, ReturnType, Type,
    Visibility,
};

struct Arg {
    name: String,
    ty: Type,
    desc: Desc,
    mode: Mode,
}

pub struct Analysis {
    pub name: String,
    pub sig: String,
    pub symbol: String,
    args: Vec<Arg>,
    ret_desc: Desc,
    ret_mode: Mode,
    ret_rust: String,
    err_rust: Option<String>,
    doc: String,
}

pub fn expand(attr: TokenStream, item: TokenStream) -> TokenStream {
    let f: ItemFn = match syn::parse2(item.clone()) {
        Ok(f) => f,
        Err(_) => {
            let e = Error::new(
                Span::call_site(),
                "knext-ffi: #[knext_ffi::export] goes on a free `pub fn`",
            )
            .to_compile_error();
            return quote!(#item #e);
        }
    };
    if !attr.is_empty() {
        let e = Error::new(
            attr.span(),
            "knext-ffi: #[knext_ffi::export] takes no arguments in ABI v1",
        )
        .to_compile_error();
        return quote!(#f #e);
    }
    match analyze(&f).map(|a| emit(&f, &a)) {
        Ok(ts) => quote!(#f #ts),
        Err(e) => {
            let e = e.to_compile_error();
            quote!(#f #e)
        }
    }
}

fn result_parts(ty: &Type) -> Option<(&Type, &Type)> {
    let Type::Path(p) = ty else { return None };
    let seg = p.path.segments.last()?;
    if seg.ident != "Result" {
        return None;
    }
    let PathArguments::AngleBracketed(a) = &seg.arguments else {
        return None;
    };
    let tys: Vec<&Type> = a
        .args
        .iter()
        .filter_map(|g| {
            if let GenericArgument::Type(t) = g {
                Some(t)
            } else {
                None
            }
        })
        .collect();
    if tys.len() == 2 {
        Some((tys[0], tys[1]))
    } else {
        None
    }
}

pub fn analyze(f: &ItemFn) -> Result<Analysis, Error> {
    let sig = &f.sig;
    let fn_name = sig.ident.to_string();
    let name = fn_name.strip_prefix("r#").unwrap_or(&fn_name).to_string();
    let here = |why: &str| Error::new(sig.ident.span(), format!("knext-ffi: `{name}`: {why}"));
    if !matches!(f.vis, Visibility::Public(_)) {
        return Err(here("#[knext_ffi::export] needs a `pub fn`"));
    }
    if let Some(a) = &sig.asyncness {
        return Err(Error::new(
            a.span(),
            format!("knext-ffi: `async fn {name}` is not supported: bun:ffi calls are synchronous; {TABLE_HINT}"),
        ));
    }
    if matches!(sig.safety, syn::Safety::Unsafe(_)) {
        return Err(here(
            "an exported fn must be safe; keep `unsafe` code inside a safe fn",
        ));
    }
    if sig.abi.is_some() {
        return Err(here(
            "write a plain Rust fn; the macro generates the `extern \"C\"` shim",
        ));
    }
    if !sig.generics.params.is_empty() || sig.generics.where_clause.is_some() {
        return Err(Error::new(
            sig.generics.span(),
            format!(
                "knext-ffi: `{name}{}`: generic parameters (including lifetimes) are not supported; {TABLE_HINT}",
                pretty(&sig.generics)
            ),
        ));
    }
    if sig.variadic.is_some() {
        return Err(here("variadic functions are not supported"));
    }
    if !name.is_ascii() {
        return Err(here(
            "an exported fn name must be ASCII (it becomes a C symbol)",
        ));
    }

    let mut args = Vec::new();
    for a in &sig.inputs {
        let pt = match a {
            FnArg::Receiver(r) => {
                return Err(Error::new(
                    r.span(),
                    format!(
                        "knext-ffi: methods (`{}`) are not supported: export a free `pub fn`; {TABLE_HINT}",
                        pretty(r)
                    ),
                ))
            }
            FnArg::Typed(pt) => pt,
        };
        let Pat::Ident(pi) = &*pt.pat else {
            return Err(Error::new(
                pt.pat.span(),
                "knext-ffi: arguments must be plain identifiers",
            ));
        };
        let raw = pi.ident.to_string();
        let arg_name = raw.strip_prefix("r#").unwrap_or(&raw).to_string();
        let (desc, mode) = classify(&pt.ty, Pos::Arg)?;
        args.push(Arg {
            name: arg_name,
            ty: (*pt.ty).clone(),
            desc,
            mode,
        });
    }

    let (ret_desc, ret_mode, ret_rust, err_rust) = match &sig.output {
        ReturnType::Default => (Desc::Unit, Mode::Unit, "()".to_string(), None),
        ReturnType::Type(_, ty) => {
            if let Some((ok, err)) = result_parts(ty) {
                let (d, m) = classify(ok, Pos::Ret)?;
                (d, m, pretty(ok), Some(pretty(err)))
            } else {
                let (d, m) = classify(ty, Pos::Ret)?;
                (d, m, pretty(ty), None)
            }
        }
    };

    let arg_tokens: Vec<String> = args.iter().map(|a| a.desc.token()).collect();
    let canonical = format!("{name}({})->{}", arg_tokens.join(","), ret_desc.token());
    let symbol = format!("knext_ffi_v1_{name}_{:08x}", fnv1a32(&canonical));
    Ok(Analysis {
        name,
        sig: canonical,
        symbol,
        args,
        ret_desc,
        ret_mode,
        ret_rust,
        err_rust,
        doc: doc_of(&f.attrs),
    })
}

fn emit(f: &ItemFn, a: &Analysis) -> TokenStream {
    let fn_ident = &f.sig.ident;
    let sym = format_ident!("{}", a.symbol);
    let schema_sym = format_ident!("{}_schema", a.symbol);
    let man_ident = format_ident!("__KNEXT_FFI_MANIFEST_{}", a.symbol);
    let pieces_ident = format_ident!("__KNEXT_FFI_PIECES_{}", a.symbol);
    let roots_ident = format_ident!("__KNEXT_FFI_ROOTS_{}", a.symbol);

    // ---- the shim --------------------------------------------------------
    let mut params = Vec::new();
    let mut convs = Vec::new();
    let mut call_args = Vec::new();
    for arg in &a.args {
        let id = format_ident!("__knext_arg_{}", arg.name);
        let p = format_ident!("__knext_ptr_{}", arg.name);
        let l = format_ident!("__knext_len_{}", arg.name);
        let n = &arg.name;
        let ty = &arg.ty;
        match arg.mode {
            Mode::Value => {
                params.push(quote!(#id: #ty));
            }
            Mode::StrRef => {
                params.push(quote!(#p: *const u8, #l: usize));
                convs.push(quote!(let #id: &str = ::knext_ffi::__rt::str_arg(#p, #l, #n)?;));
            }
            Mode::StrOwned => {
                params.push(quote!(#p: *const u8, #l: usize));
                convs.push(quote!(
                    let #id = ::std::string::String::from(::knext_ffi::__rt::str_arg(#p, #l, #n)?);
                ));
            }
            Mode::BytesRef => {
                params.push(quote!(#p: *const u8, #l: usize));
                convs.push(quote!(let #id: &[u8] = ::knext_ffi::__rt::bytes_arg(#p, #l);));
            }
            Mode::BytesOwned => {
                params.push(quote!(#p: *const u8, #l: usize));
                convs.push(quote!(let #id = ::knext_ffi::__rt::bytes_arg(#p, #l).to_vec();));
            }
            Mode::Json => {
                params.push(quote!(#p: *const u8, #l: usize));
                convs.push(quote!(let #id: #ty = ::knext_ffi::__rt::json_arg::<#ty>(#p, #l, #n)?;));
            }
            Mode::Unit => unreachable!("() is rejected as an argument"),
        }
        call_args.push(quote!(#id));
    }
    let wrap = |v: TokenStream| -> TokenStream {
        if a.ret_mode == Mode::Json {
            quote!(::knext_ffi::__rt::Json(#v))
        } else {
            v
        }
    };
    let body = if a.err_rust.is_some() {
        let ok = wrap(quote!(__knext_v));
        quote! {
            ::core::result::Result::Ok(match #fn_ident(#(#call_args),*) {
                ::core::result::Result::Ok(__knext_v) => ::core::result::Result::Ok(#ok),
                ::core::result::Result::Err(__knext_e) =>
                    ::core::result::Result::Err(::std::string::ToString::to_string(&__knext_e)),
            })
        }
    } else {
        let ok = wrap(quote!(#fn_ident(#(#call_args),*)));
        quote!(::core::result::Result::Ok(::core::result::Result::Ok(#ok)))
    };

    // ---- the schema hash (transitive, const-evaluated) ---------------------
    let mut named: Vec<Type> = Vec::new();
    for arg in &a.args {
        arg.desc.named(&mut named);
    }
    a.ret_desc.named(&mut named);
    let roots = named
        .iter()
        .map(|t| quote!(<#t as ::knext_ffi::__rt::KnextSchema>::SCHEMA));
    let sig_lit = &a.sig;

    // ---- the manifest record ---------------------------------------------
    let mut m = Pieces::default();
    m.lit(&format!(
        "KNEXTFFI1{{\"v\":1,\"kind\":\"fn\",\"name\":{},\"symbol\":{},\"sig\":{},\"doc\":{},\"args\":[",
        json_str(&a.name),
        json_str(&a.symbol),
        json_str(&a.sig),
        json_str(&a.doc)
    ));
    for (i, arg) in a.args.iter().enumerate() {
        if i > 0 {
            m.lit(",");
        }
        m.lit(&format!("{{\"name\":{},\"type\":", json_str(&arg.name)));
        arg.desc.pieces(&mut m);
        m.lit(&format!(",\"rust\":{}}}", json_str(&pretty(&arg.ty))));
    }
    m.lit("],\"ret\":{\"type\":");
    a.ret_desc.pieces(&mut m);
    m.lit(&format!(",\"rust\":{}}},\"err\":", json_str(&a.ret_rust)));
    match &a.err_rust {
        Some(e) => m.lit(&format!("{{\"rust\":{}}}", json_str(e))),
        None => m.lit("null"),
    }
    m.lit("}\0");
    let pieces = m.to_tokens();

    quote! {
        #[doc(hidden)]
        #[unsafe(no_mangle)]
        #[allow(non_snake_case, clippy::missing_safety_doc, clippy::too_many_arguments)]
        pub unsafe extern "C" fn #sym(#(#params,)* __knext_out: *mut [u64; 2]) -> i32 {
            unsafe {
                ::knext_ffi::__rt::call(__knext_out, move || {
                    #(#convs)*
                    #body
                })
            }
        }

        #[doc(hidden)]
        #[allow(non_upper_case_globals)]
        const #roots_ident: &[&::knext_ffi::__rt::Schema] = &[#(#roots),*];

        #[doc(hidden)]
        #[unsafe(no_mangle)]
        #[allow(non_snake_case)]
        pub extern "C" fn #schema_sym() -> u64 {
            const H: u64 = ::knext_ffi::__rt::schema_hash(#sig_lit, #roots_ident);
            H
        }

        #[doc(hidden)]
        #[allow(non_upper_case_globals)]
        const #pieces_ident: &[&str] = &[#(#pieces),*];

        #[doc(hidden)]
        #[unsafe(no_mangle)]
        #[used]
        #[allow(non_upper_case_globals)]
        pub static #man_ident: [u8; ::knext_ffi::__rt::pieces_len(#pieces_ident)] =
            ::knext_ffi::__rt::pieces_concat(#pieces_ident);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn symbol(src: &str) -> (String, String) {
        let f: ItemFn = syn::parse_str(src).unwrap();
        let a = analyze(&f).unwrap_or_else(|e| panic!("{src}: {e}"));
        (a.sig, a.symbol)
    }

    #[test]
    fn sig_and_symbol_follow_d4() {
        assert_eq!(
            symbol("pub fn greet(name: String) -> String { name }"),
            (
                "greet(string)->string".into(),
                "knext_ffi_v1_greet_8a119d0c".into()
            )
        );
        assert_eq!(symbol("pub fn noop() {}").0, "noop()->unit");
        assert_eq!(
            symbol("pub fn p(s: &str) -> Result<Vec<Point>, E> { todo!() }").0,
            "p(string)->vec<Point>",
            "a Result is spelled as its Ok type"
        );
        assert_eq!(
            symbol("pub fn r#match(r#type: Option<u64>) -> Vec<u8> { todo!() }").0,
            "match(option<u64>)->bytes"
        );
    }

    #[test]
    fn changing_a_parameter_type_changes_the_symbol() {
        let (_, a) = symbol("pub fn f(a: i32, b: &str) -> u64 { 0 }");
        let (_, b) = symbol("pub fn f(a: i64, b: &str) -> u64 { 0 }");
        let (_, c) = symbol("pub fn f(a: i32, b: &[u8]) -> u64 { 0 }");
        let (_, d) = symbol("pub fn f(a: i32, b: &str) -> u32 { 0 }");
        let (_, e) = symbol("pub fn f(b: &str, a: i32) -> u64 { 0 }");
        let all = [&a, &b, &c, &d, &e];
        for (i, x) in all.iter().enumerate() {
            assert!(
                x.starts_with("knext_ffi_v1_f_") && x.len() == "knext_ffi_v1_f_".len() + 8,
                "{x}"
            );
            for y in &all[i + 1..] {
                assert_ne!(x, y, "every signature change must change the symbol");
            }
        }
        // Same layout, same symbol: renaming an argument or borrowing
        // instead of owning does not change what crosses the boundary.
        assert_eq!(a, symbol("pub fn f(x: i32, y: String) -> u64 { 0 }").1);
    }
}
