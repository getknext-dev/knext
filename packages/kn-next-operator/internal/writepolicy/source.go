/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package writepolicy

import (
	"context"
	"fmt"

	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	authenticationv1 "k8s.io/api/authentication/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// ClientSource reads the live objects with a plain clientset.
//
// It does NOT use the manager's cached client: that one lists and watches, and
// the operator's role grants only `get` on these two named objects
// (config/rbac/write_policy_reader_role.yaml). Nothing here writes.
type ClientSource struct {
	cs kubernetes.Interface
}

// NewClientSource builds a ClientSource from the operator's own rest config, so
// the identity it reports is the identity the operator's writes carry.
func NewClientSource(cfg *rest.Config) (*ClientSource, error) {
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("building the write-policy clientset: %w", err)
	}
	return &ClientSource{cs: cs}, nil
}

// Policy gets the named ValidatingAdmissionPolicy; (nil, nil) when it is absent.
func (s *ClientSource) Policy(ctx context.Context, name string) (*admissionregistrationv1.ValidatingAdmissionPolicy, error) {
	p, err := s.cs.AdmissionregistrationV1().ValidatingAdmissionPolicies().Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return nil, nil
	}
	return p, err
}

// Binding gets the named ValidatingAdmissionPolicyBinding; (nil, nil) when absent.
func (s *ClientSource) Binding(ctx context.Context, name string) (*admissionregistrationv1.ValidatingAdmissionPolicyBinding, error) {
	b, err := s.cs.AdmissionregistrationV1().ValidatingAdmissionPolicyBindings().Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return nil, nil
	}
	return b, err
}

// OperatorUsername asks the apiserver who it thinks this process is
// (SelfSubjectReview, GA in Kubernetes 1.28). That is the username an
// admission policy's matchCondition sees, so comparing against it catches a
// namespace or service-account name that differs from what the bundle rendered.
// Every authenticated user may create a SelfSubjectReview (system:basic-user),
// so this adds nothing to the operator's role.
func (s *ClientSource) OperatorUsername(ctx context.Context) (string, error) {
	r, err := s.cs.AuthenticationV1().SelfSubjectReviews().Create(ctx, &authenticationv1.SelfSubjectReview{}, metav1.CreateOptions{})
	if err != nil {
		return "", err
	}
	return r.Status.UserInfo.Username, nil
}
