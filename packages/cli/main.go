package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/AhmedElBanna80/Knative-open-nextjs/packages/cli/config"
	"github.com/AhmedElBanna80/Knative-open-nextjs/packages/distribution-builder/ingress"
)

func main() {
	fmt.Println("🚀 Knative Open Next.js CLI")

	workDir, err := os.Getwd()
	if err != nil {
		log.Fatal(err)
	}

	// 1. Load Configuration
	cfg, err := config.LoadConfig("scripts/print-config.ts", workDir)
	if err != nil {
		log.Fatalf("❌ Failed to load config: %v", err)
	}
	fmt.Printf("✅ Loaded config for app: %s\n", cfg.Name)

	// 2. Deployment Logic (Simplified for PoC)
	// In a real scenario, this would orchestrate 'next build', 'bundle-assets.ts', etc.
	// For now, let's focus on the Ingress generation.

	fmt.Println("🌐 Generating Unified Ingress...")
	
	// Mock zones for now - in real CLI this would come from source scanning or config
	zones := []ingress.ZoneInfo{
		{Name: "dashboard", Path: "/dashboard"},
		{Name: "users", Path: "/users"},
		{Name: "audit", Path: "/audit"},
		{Name: "setup", Path: "/setup"},
	}

	ig := ingress.NewIngressGenerator(cfg, zones)
	ingressYaml := ig.GenerateIngressYAML()

	ingressFile := filepath.Join(workDir, "deploy", "ingress.yaml")
	err = os.WriteFile(ingressFile, []byte(ingressYaml), 0644)
	if err != nil {
		log.Fatalf("❌ Failed to write ingress.yaml: %v", err)
	}
	fmt.Printf("✅ Generated %s\n", ingressFile)

	// 3. Compile Bun Binary (via script)
	fmt.Println("🔨 Compiling Bun Bytecode Binary...")
	compileCmd := exec.Command("bun", "run", "scripts/generate-bun-manifest.ts")
	compileCmd.Stdout = os.Stdout
	compileCmd.Stderr = os.Stderr
	if err := compileCmd.Run(); err != nil {
		log.Fatalf("❌ Failed to run manifest generator: %v", err)
	}

	fmt.Println("\n✨ CLI Task Complete. Use 'kubectl apply -f deploy/ingress.yaml' to update routing.")
}
