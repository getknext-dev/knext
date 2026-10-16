//! The example function's business logic: the two RPCs of the
//! `ExampleService` contract in `proto/example/v1/example.proto`. Replace it
//! with your own.
//!
//! The store is an in-memory map, so it is per pod and lost on scale-to-zero.
//! A real function keeps its data in its zone's own database, read from the
//! `DATABASE_URL` its zone binds; it never reads another zone's database.

use std::collections::HashMap;
use std::sync::RwLock;

use connectrpc::{ConnectError, RequestContext, Response, ServiceRequest, ServiceResult};

use crate::connect::example::v1::ExampleService;
use crate::proto::example::v1::{GetItemRequest, GetItemResponse, PutItemRequest, PutItemResponse};

/// The example service: implements [`ExampleService`].
#[derive(Debug, Default)]
pub struct Service {
    items: RwLock<HashMap<String, String>>,
}

impl Service {
    /// An empty service.
    pub fn new() -> Self {
        Self::default()
    }
}

// Returning the concrete response type refines the trait's
// `impl Encodable<_>` bound, which is what the generated trait expects.
#[allow(refining_impl_trait)]
impl ExampleService for Service {
    /// Reads one item. It is a read (`NO_SIDE_EFFECTS`), so the zone may
    /// retry it.
    async fn get_item(
        &self,
        _ctx: RequestContext,
        request: ServiceRequest<'_, GetItemRequest>,
    ) -> ServiceResult<GetItemResponse> {
        if request.id.is_empty() {
            return Err(ConnectError::invalid_argument("id is required"));
        }
        let items = self
            .items
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(value) = items.get(request.id) else {
            return Err(ConnectError::not_found("item not found"));
        };
        Response::ok(GetItemResponse {
            id: request.id.to_owned(),
            value: value.clone(),
            ..Default::default()
        })
    }

    /// Writes one item. A write is never retried by the zone, and each call
    /// carries an `idempotency-key` header: a store that is not naturally
    /// idempotent records that key with the write so a resubmitted write is
    /// recognised and applied once.
    async fn put_item(
        &self,
        _ctx: RequestContext,
        request: ServiceRequest<'_, PutItemRequest>,
    ) -> ServiceResult<PutItemResponse> {
        if request.id.is_empty() {
            return Err(ConnectError::invalid_argument("id is required"));
        }
        self.items
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(request.id.to_owned(), request.value.to_owned());
        Response::ok(PutItemResponse::default())
    }
}

#[cfg(test)]
mod tests {
    use buffa::Message;
    use buffa::view::HasMessageView;
    use bytes::Bytes;
    use connectrpc::{CodecFormat, Encodable, ErrorCode};
    use http::HeaderMap;

    use super::*;

    async fn get(svc: &Service, id: &str) -> Result<GetItemResponse, ConnectError> {
        let body = Bytes::from(
            GetItemRequest {
                id: id.into(),
                ..Default::default()
            }
            .encode_to_vec(),
        );
        let view = GetItemRequest::decode_view(&body).unwrap();
        let req = ServiceRequest::<GetItemRequest>::from_parts(&view, &body);
        let resp = svc
            .get_item(RequestContext::new(HeaderMap::new()), req)
            .await?;
        let bytes = Encodable::encode(&resp.body, CodecFormat::Proto).unwrap();
        Ok(GetItemResponse::decode_from_slice(&bytes).unwrap())
    }

    async fn put(svc: &Service, id: &str, value: &str) -> Result<(), ConnectError> {
        let body = Bytes::from(
            PutItemRequest {
                id: id.into(),
                value: value.into(),
                ..Default::default()
            }
            .encode_to_vec(),
        );
        let view = PutItemRequest::decode_view(&body).unwrap();
        let req = ServiceRequest::<PutItemRequest>::from_parts(&view, &body);
        svc.put_item(RequestContext::new(HeaderMap::new()), req)
            .await?;
        Ok(())
    }

    #[tokio::test]
    async fn put_then_get() {
        let svc = Service::new();
        put(&svc, "a", "1").await.unwrap();
        let got = get(&svc, "a").await.unwrap();
        assert_eq!((got.id.as_str(), got.value.as_str()), ("a", "1"));
    }

    #[tokio::test]
    async fn put_overwrites() {
        let svc = Service::new();
        put(&svc, "a", "1").await.unwrap();
        put(&svc, "a", "2").await.unwrap();
        assert_eq!(get(&svc, "a").await.unwrap().value, "2");
    }

    #[tokio::test]
    async fn get_missing_is_not_found() {
        let err = get(&Service::new(), "missing").await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn empty_id_is_invalid_argument() {
        let svc = Service::new();
        assert_eq!(
            get(&svc, "").await.unwrap_err().code,
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            put(&svc, "", "v").await.unwrap_err().code,
            ErrorCode::InvalidArgument
        );
    }
}
