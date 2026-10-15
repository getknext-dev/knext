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

// h2cecho is the stand-in for both ends of a zone-function call in the kind
// drills (test/networkpolicy-enforcement-drill.sh, function leg, and the
// zone-functions e2e). It serves plain HTTP/1.1 AND HTTP/2 cleartext with prior
// knowledge (h2c) on $PORT, the protocol Knative speaks to a container port
// named h2c.
//
//   - Any path: answers with the protocol the request arrived on, so a drill can
//     assert the call really crossed the h2c path.
//   - /call?env=<NAME>_SERVICE_URL: acts as a ZONE. It reads the named variable
//     (the binding env the operator renders into the zone), calls that URL and
//     returns the function's answer, so an e2e can drive zone -> function through
//     the injected URL.
//
// Not shipped: built only by the drills. No dependencies beyond the standard
// library.
package main

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	protocols.SetUnencryptedHTTP2(true)
	client := &http.Client{Timeout: 120 * time.Second}

	mux := http.NewServeMux()
	mux.HandleFunc("/call", func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("env")
		target := os.Getenv(name)
		if target == "" {
			http.Error(w, fmt.Sprintf("%s is not set in this zone", name), http.StatusFailedDependency)
			return
		}
		resp, err := client.Get(target)
		if err != nil {
			http.Error(w, fmt.Sprintf("calling %s: %v", target, err), http.StatusBadGateway)
			return
		}
		defer func() { _ = resp.Body.Close() }()
		body, _ := io.ReadAll(resp.Body)
		w.WriteHeader(resp.StatusCode)
		fmt.Fprintf(w, "zone-called %s=%s -> %s", name, target, body)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "knext-function-ok proto=%s\n", r.Proto)
	})

	srv := &http.Server{Addr: ":" + port, Protocols: protocols, Handler: mux}
	log.Printf("h2cecho listening on :%s (HTTP/1.1 + h2c)", port)
	log.Fatal(srv.ListenAndServe())
}
