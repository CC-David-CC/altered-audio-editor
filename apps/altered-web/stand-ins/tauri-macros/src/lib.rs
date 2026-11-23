// SPDX-License-Identifier: GPL-3.0-or-later
//! The stand-in `tauri` crate's macros (see its lib.rs).
//!
//! `#[command]` keeps the function and adds `__pg_cmd_<name>(app, args) -> Reply` beside it: each argument comes from
//! the app (`State<'_, T>`, `AppHandle`, `WebviewWindow`) or from the call's JSON by its camelCase name, as Tauri
//! passes them; an async command runs to the end at once; the result becomes JSON, the bytes of an `ipc::Response`,
//! or an error. `generate_handler![a::b::cmd, …]` matches a command's name to its `__pg_cmd_`.
use proc_macro::TokenStream;
use quote::{format_ident, quote};
use syn::parse::Parser;
use syn::punctuated::Punctuated;
use syn::{FnArg, GenericArgument, ItemFn, Pat, Path, PathArguments, ReturnType, Token, Type};

fn last_ident(ty: &Type) -> Option<(String, &PathArguments)> {
    match ty {
        Type::Path(p) => p.path.segments.last().map(|s| (s.ident.to_string(), &s.arguments)),
        Type::Reference(r) => last_ident(&r.elem),
        Type::Paren(p) => last_ident(&p.elem),
        _ => None,
    }
}

fn type_args(args: &PathArguments) -> Vec<&Type> {
    match args {
        PathArguments::AngleBracketed(a) => a
            .args
            .iter()
            .filter_map(|g| match g {
                GenericArgument::Type(t) => Some(t),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn camel(name: &str) -> String {
    let mut out = String::new();
    let mut up = false;
    for c in name.trim_start_matches('_').chars() {
        if c == '_' {
            up = true;
        } else if up {
            out.extend(c.to_uppercase());
            up = false;
        } else {
            out.push(c);
        }
    }
    out
}

#[proc_macro_attribute]
pub fn command(_attr: TokenStream, item: TokenStream) -> TokenStream {
    let f = syn::parse_macro_input!(item as ItemFn);
    let name = &f.sig.ident;
    let vis = &f.vis;
    let wrapper = format_ident!("__pg_cmd_{}", name);
    let mut lets = Vec::new();
    let mut names = Vec::new();
    for (i, arg) in f.sig.inputs.iter().enumerate() {
        let FnArg::Typed(pt) = arg else { continue };
        let var = format_ident!("__a{}", i);
        let key = match &*pt.pat {
            Pat::Ident(p) => camel(&p.ident.to_string()),
            _ => String::new(),
        };
        let ty = &*pt.ty;
        let get = match last_ident(ty) {
            Some((s, args)) if s == "State" => {
                let inner = type_args(args).into_iter().next();
                quote! { ::tauri::Manager::state::<#inner>(__app) }
            }
            Some((s, _)) if s == "AppHandle" => quote! { ::core::clone::Clone::clone(__app) },
            Some((s, _)) if s == "WebviewWindow" || s == "Window" => {
                quote! { ::tauri::Manager::get_webview_window(__app, "main").unwrap_or_default() }
            }
            _ => quote! {
                match ::tauri::__private::arg::<#ty>(__args, #key) {
                    Ok(v) => v,
                    Err(e) => return ::tauri::__private::Reply::Err(e.into()),
                }
            },
        };
        lets.push(quote! { let #var = #get; });
        names.push(var);
    }
    let call = if f.sig.asyncness.is_some() {
        quote! { ::tauri::__private::block_on(#name(#(#names),*)) }
    } else {
        quote! { #name(#(#names),*) }
    };
    let bytes = |t: &Type| last_ident(t).is_some_and(|(s, _)| s == "Response");
    let reply = match &f.sig.output {
        ReturnType::Default => quote! { { __out; ::tauri::__private::Reply::Json(::tauri::__private::Value::Null) } },
        ReturnType::Type(_, ty) => match last_ident(ty) {
            Some((s, args)) if s == "Result" => {
                let ok = type_args(args).into_iter().next();
                if ok.is_some_and(bytes) {
                    quote! { match __out { Ok(r) => ::tauri::__private::Reply::Bytes(r.into_bytes()), Err(e) => ::tauri::__private::Reply::error(e) } }
                } else {
                    quote! { match __out { Ok(v) => ::tauri::__private::Reply::json(&v), Err(e) => ::tauri::__private::Reply::error(e) } }
                }
            }
            _ if bytes(ty) => quote! { ::tauri::__private::Reply::Bytes(__out.into_bytes()) },
            _ => quote! { ::tauri::__private::Reply::json(&__out) },
        },
    };
    quote! {
        #f
        #[doc(hidden)]
        #[allow(clippy::all, unused_variables, unreachable_code)]
        #vis fn #wrapper(__app: &::tauri::AppHandle, __args: &::tauri::__private::Value) -> ::tauri::__private::Reply {
            #(#lets)*
            let __out = #call;
            #reply
        }
    }
    .into()
}

#[proc_macro]
pub fn generate_handler(input: TokenStream) -> TokenStream {
    let paths = match Punctuated::<Path, Token![,]>::parse_terminated.parse(input) {
        Ok(p) => p,
        Err(e) => return e.to_compile_error().into(),
    };
    let arms = paths.iter().map(|p| {
        let mut w = p.clone();
        let last = w.segments.last_mut().expect("a command path");
        let name = last.ident.to_string();
        last.ident = format_ident!("__pg_cmd_{}", last.ident);
        quote! { #name => ::core::option::Option::Some(#w(__app, __args)), }
    });
    quote! {{
        fn __pg_handler(__cmd: &str, __app: &::tauri::AppHandle, __args: &::tauri::__private::Value) -> ::core::option::Option<::tauri::__private::Reply> {
            match __cmd {
                #(#arms)*
                _ => ::core::option::Option::None,
            }
        }
        __pg_handler as ::tauri::__private::Handler
    }}
    .into()
}

#[proc_macro]
pub fn generate_context(_input: TokenStream) -> TokenStream {
    quote! { ::tauri::Context::default() }.into()
}
