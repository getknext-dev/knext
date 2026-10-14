//! `#[knext_ffi::record]` on a struct with named fields or a unit-only enum:
//! serde derives (through knext_ffi's re-export), the 64-bit-as-string field
//! adapter, the `KnextSchema` impl, and the embedded manifest record.

use crate::types::{classify, doc_of, json_str, pretty, Pieces, Pos, TABLE_HINT};
use proc_macro2::{Span, TokenStream};
use quote::{format_ident, quote};
use syn::{spanned::Spanned, Error, Fields, Item, ItemEnum, ItemStruct, Type};

pub fn expand(attr: TokenStream, item: TokenStream) -> TokenStream {
    if !attr.is_empty() {
        let e = Error::new(
            attr.span(),
            "knext-ffi: #[knext_ffi::record] takes no arguments in ABI v1",
        )
        .to_compile_error();
        return quote!(#item #e);
    }
    let parsed: Result<Item, _> = syn::parse2(item.clone());
    let out = match parsed {
        Ok(Item::Struct(s)) => expand_struct(s),
        Ok(Item::Enum(e)) => expand_enum(e),
        _ => Err(Error::new(
            Span::call_site(),
            format!("knext-ffi: #[knext_ffi::record] goes on a struct with named fields or an enum with unit variants; {TABLE_HINT}"),
        )),
    };
    match out {
        Ok(ts) => ts,
        Err(e) => {
            let e = e.to_compile_error();
            quote!(#item #e)
        }
    }
}

fn no_serde_attrs(attrs: &[syn::Attribute]) -> Result<(), Error> {
    for a in attrs {
        if a.path().is_ident("serde") {
            return Err(Error::new(
                a.span(),
                "knext-ffi: #[serde(...)] attributes are not allowed on a #[knext_ffi::record]: names cross verbatim and the embedded manifest must describe the wire format exactly",
            ));
        }
    }
    Ok(())
}

fn check_header(ident: &syn::Ident, generics: &syn::Generics) -> Result<String, Error> {
    let raw = ident.to_string();
    let name = raw.strip_prefix("r#").unwrap_or(&raw).to_string();
    if !generics.params.is_empty() || generics.where_clause.is_some() {
        return Err(Error::new(
            generics.span(),
            format!(
                "knext-ffi: generic record `{name}{}` is not supported; {TABLE_HINT}",
                pretty(generics)
            ),
        ));
    }
    if !name.is_ascii() {
        return Err(Error::new(
            ident.span(),
            "knext-ffi: a record name must be ASCII (it names a C symbol)",
        ));
    }
    Ok(name)
}

fn manifest(name: &str, kind: &str, pieces: Pieces) -> TokenStream {
    let pieces_ident = format_ident!("__KNEXT_FFI_PIECES_{}_{}", kind, name);
    let man_ident = format_ident!("__KNEXT_FFI_MANIFEST_{}_{}", kind, name);
    let pieces = pieces.to_tokens();
    quote! {
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

fn expand_struct(mut s: ItemStruct) -> Result<TokenStream, Error> {
    let name = check_header(&s.ident, &s.generics)?;
    no_serde_attrs(&s.attrs)?;
    let Fields::Named(fields) = &mut s.fields else {
        return Err(Error::new(
            s.ident.span(),
            format!("knext-ffi: record `{name}` must have named fields (tuple and unit structs cannot cross as JSON objects); {TABLE_HINT}"),
        ));
    };
    let mut canon = format!("{name}{{");
    let mut deps: Vec<Type> = Vec::new();
    let mut pieces = Pieces::default();
    pieces.lit(&format!(
        "KNEXTFFI1{{\"v\":1,\"kind\":\"record\",\"name\":{},\"doc\":{},\"fields\":[",
        json_str(&name),
        json_str(&doc_of(&s.attrs))
    ));
    for (i, f) in fields.named.iter_mut().enumerate() {
        no_serde_attrs(&f.attrs)?;
        let raw = f.ident.as_ref().expect("named field").to_string();
        let fname = raw.strip_prefix("r#").unwrap_or(&raw).to_string();
        let (desc, _) = classify(&f.ty, Pos::Json)?;
        if desc.mentions(&name) {
            return Err(Error::new(
                f.ty.span(),
                format!("knext-ffi: recursive record `{name}` (field `{fname}: {}`) is not supported in ABI v1; {TABLE_HINT}", pretty(&f.ty)),
            ));
        }
        desc.named(&mut deps);
        if i > 0 {
            canon.push(',');
            pieces.lit(",");
        }
        canon.push_str(&format!("{fname}:{}", desc.token()));
        pieces.lit(&format!("{{\"name\":{},\"type\":", json_str(&fname)));
        desc.pieces(&mut pieces);
        pieces.lit(&format!(",\"rust\":{}}}", json_str(&pretty(&f.ty))));
        f.attrs
            .push(syn::parse_quote!(#[serde(with = "::knext_ffi::wire")]));
    }
    canon.push('}');
    pieces.lit("]}\0");

    let ident = &s.ident;
    let man = manifest(&name, "record", pieces);
    let dep_schemas = deps
        .iter()
        .map(|t| quote!(<#t as ::knext_ffi::__rt::KnextSchema>::SCHEMA));
    Ok(quote! {
        #[derive(::knext_ffi::serde::Serialize, ::knext_ffi::serde::Deserialize)]
        #[serde(crate = "::knext_ffi::serde", deny_unknown_fields)]
        #s

        impl ::knext_ffi::__rt::KnextSchema for #ident {
            const SCHEMA: &'static ::knext_ffi::__rt::Schema = &::knext_ffi::__rt::Schema {
                name: #name,
                kind: "record",
                canon: #canon,
                deps: &[#(#dep_schemas),*],
            };
        }

        impl ::knext_ffi::wire::Wire for #ident {
            fn ser<S: ::knext_ffi::serde::Serializer>(&self, s: S) -> ::core::result::Result<S::Ok, S::Error> {
                ::knext_ffi::serde::Serialize::serialize(self, s)
            }
            fn de<'de, D: ::knext_ffi::serde::Deserializer<'de>>(d: D) -> ::core::result::Result<Self, D::Error> {
                <Self as ::knext_ffi::serde::Deserialize<'de>>::deserialize(d)
            }
        }

        #man
    })
}

fn expand_enum(e: ItemEnum) -> Result<TokenStream, Error> {
    let name = check_header(&e.ident, &e.generics)?;
    no_serde_attrs(&e.attrs)?;
    let mut variants = Vec::new();
    for v in &e.variants {
        no_serde_attrs(&v.attrs)?;
        if !matches!(v.fields, Fields::Unit) {
            return Err(Error::new(
                v.span(),
                format!(
                    "knext-ffi: data-carrying enum variant `{name}::{}` is not supported: only unit variants cross (as their name); {TABLE_HINT}",
                    v.ident
                ),
            ));
        }
        let raw = v.ident.to_string();
        variants.push(raw.strip_prefix("r#").unwrap_or(&raw).to_string());
    }
    if variants.is_empty() {
        return Err(Error::new(
            e.ident.span(),
            format!("knext-ffi: enum `{name}` has no variants; {TABLE_HINT}"),
        ));
    }
    let canon = format!("{name}[{}]", variants.join("|"));
    let mut pieces = Pieces::default();
    pieces.lit(&format!(
        "KNEXTFFI1{{\"v\":1,\"kind\":\"enum\",\"name\":{},\"doc\":{},\"variants\":[{}]}}\0",
        json_str(&name),
        json_str(&doc_of(&e.attrs)),
        variants
            .iter()
            .map(|v| json_str(v))
            .collect::<Vec<_>>()
            .join(",")
    ));
    let ident = &e.ident;
    let man = manifest(&name, "enum", pieces);
    Ok(quote! {
        #[derive(::knext_ffi::serde::Serialize, ::knext_ffi::serde::Deserialize)]
        #[serde(crate = "::knext_ffi::serde")]
        #e

        impl ::knext_ffi::__rt::KnextSchema for #ident {
            const SCHEMA: &'static ::knext_ffi::__rt::Schema = &::knext_ffi::__rt::Schema {
                name: #name,
                kind: "enum",
                canon: #canon,
                deps: &[],
            };
        }

        impl ::knext_ffi::wire::Wire for #ident {
            fn ser<S: ::knext_ffi::serde::Serializer>(&self, s: S) -> ::core::result::Result<S::Ok, S::Error> {
                ::knext_ffi::serde::Serialize::serialize(self, s)
            }
            fn de<'de, D: ::knext_ffi::serde::Deserializer<'de>>(d: D) -> ::core::result::Result<Self, D::Error> {
                <Self as ::knext_ffi::serde::Deserialize<'de>>::deserialize(d)
            }
        }

        #man
    })
}
