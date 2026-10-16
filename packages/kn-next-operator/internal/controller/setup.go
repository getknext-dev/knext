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

package controller

import (
	"fmt"

	ctrl "sigs.k8s.io/controller-runtime"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	platformv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/platform/v1alpha1"
	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// SetupControllers registers every reconciler the operator runs on mgr. It is
// the one place that decides WHICH controllers exist, so cmd/main.go and the
// start-up envtests exercise the same wiring rather than a copy of it.
//
// The NextApp reconciler always runs. The KnextPlatform reconciler runs only
// when the cluster serves the KnextPlatform kind (ADR-0064 D3): an operator
// upgraded onto a cluster where the CRD was not installed — a partial bundle
// apply, or a GitOps tool that syncs CRDs separately — must start and behave
// exactly as before the platform layer existed, and never crash-loop on a
// missing kind. The NextApp reconciler makes the same discovery decision for
// its own KnextPlatform watch (SetupWithManager).
func SetupControllers(mgr ctrl.Manager, cleaner ExternalCleaner) error {
	// Zone functions (ADR-0004): the BackendService reconciler, and the NextApp
	// reconciler's BackendService watch, run only when the cluster serves the
	// kind — the same discovery decision as the platform layer, for the same
	// reason (a partial bundle apply must not crash-loop the operator). Their
	// metrics are registered regardless (backendservice_metrics.go).
	functionsInstalled, err := appsv1alpha1.BackendServiceCRDInstalled(mgr.GetRESTMapper())
	if err != nil {
		return fmt.Errorf("BackendService controller: %w", err)
	}

	if err := (&NextAppReconciler{
		Client:                   mgr.GetClient(),
		Scheme:                   mgr.GetScheme(),
		APIReader:                mgr.GetAPIReader(),
		Recorder:                 mgr.GetEventRecorderFor("nextapp-controller"),
		Cleaner:                  cleaner,
		BackendServiceCRDPresent: functionsInstalled,
	}).SetupWithManager(mgr); err != nil {
		return fmt.Errorf("NextApp controller: %w", err)
	}

	if functionsInstalled {
		if err := (&BackendServiceReconciler{
			Client:    mgr.GetClient(),
			Scheme:    mgr.GetScheme(),
			APIReader: mgr.GetAPIReader(),
			Recorder:  mgr.GetEventRecorderFor("backendservice-controller"),
		}).SetupWithManager(mgr); err != nil {
			return fmt.Errorf("BackendService controller: %w", err)
		}
	} else {
		logf.Log.WithName("setup").Info("BackendService CRD not installed: zone functions are off " +
			"(a NextApp with spec.backends reports BackendBindings=BackendServiceCRDMissing); install the CRD and restart the operator")
	}

	installed, err := platformv1alpha1.CRDInstalled(mgr.GetRESTMapper())
	if err != nil {
		// Unknown is not absent: a discovery blip must stop start-up, not quietly
		// turn the platform layer off.
		return fmt.Errorf("KnextPlatform controller: %w", err)
	}
	if installed {
		if err := (&KnextPlatformReconciler{
			Client: mgr.GetClient(),
			Scheme: mgr.GetScheme(),
		}).SetupWithManager(mgr); err != nil {
			return fmt.Errorf("KnextPlatform controller: %w", err)
		}
	}
	return nil
}
