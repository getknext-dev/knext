package writerscaler

import "testing"

// stdBounds: 250m..2000m CPU (step 250m), 256Mi..1Gi mem (step 256Mi), up 0.80 / down 0.30.
func stdBounds() Bounds {
	const Mi = 1 << 20
	return Bounds{
		MinCPUMilli:  250,
		MaxCPUMilli:  2000,
		CPUStepMilli: 250,
		MinMemBytes:  256 * Mi,
		MaxMemBytes:  1024 * Mi,
		MemStepBytes: 256 * Mi,
		UpRatio:      0.80,
		DownRatio:    0.30,
	}
}

func TestDecide(t *testing.T) {
	const Mi = 1 << 20
	b := stdBounds()

	tests := []struct {
		name       string
		s          Sample
		wantCPUDir Direction
		wantMemDir Direction
		wantChgCPU bool
		wantChgMem bool
		wantCPULim int64
		wantMemLim int64
		wantBounce bool
	}{
		{
			name:       "cpu hot -> scale up one step, clamped",
			s:          Sample{CPUUsageMilli: 480, CPULimMilli: 500, CPUReqMilli: 250, MemUsageBytes: 300 * Mi, MemLimBytes: 512 * Mi, MemReqBytes: 256 * Mi},
			wantCPUDir: Up, wantChgCPU: true, wantCPULim: 750,
			wantMemDir: Hold, wantMemLim: 512 * Mi,
		},
		{
			name:       "cpu idle -> scale down one step",
			s:          Sample{CPUUsageMilli: 100, CPULimMilli: 1000, CPUReqMilli: 500, MemUsageBytes: 100 * Mi, MemLimBytes: 512 * Mi, MemReqBytes: 256 * Mi},
			wantCPUDir: Down, wantChgCPU: true, wantCPULim: 750,
			wantMemDir: Down, wantChgMem: true, wantMemLim: 256 * Mi,
		},
		{
			name:       "cpu at max, still hot -> Up direction but NO change (clamped)",
			s:          Sample{CPUUsageMilli: 1900, CPULimMilli: 2000, CPUReqMilli: 2000, MemUsageBytes: 300 * Mi, MemLimBytes: 512 * Mi, MemReqBytes: 256 * Mi},
			wantCPUDir: Up, wantChgCPU: false, wantCPULim: 2000,
			wantMemDir: Hold,
		},
		{
			name:       "cpu at min, idle -> Down direction but NO change (clamped)",
			s:          Sample{CPUUsageMilli: 10, CPULimMilli: 250, CPUReqMilli: 250, MemUsageBytes: 100 * Mi, MemLimBytes: 512 * Mi, MemReqBytes: 256 * Mi},
			wantCPUDir: Down, wantChgCPU: false, wantCPULim: 250,
			wantMemDir: Down, wantChgMem: true,
		},
		{
			name:       "mem hot -> scale up one step",
			s:          Sample{CPUUsageMilli: 500, CPULimMilli: 1000, CPUReqMilli: 500, MemUsageBytes: 460 * Mi, MemLimBytes: 512 * Mi, MemReqBytes: 256 * Mi},
			wantCPUDir: Hold,
			wantMemDir: Up, wantChgMem: true, wantMemLim: 768 * Mi,
		},
		{
			name:       "mem hot at MAX limit -> NeedsBounce (never grow live), no mem change",
			s:          Sample{CPUUsageMilli: 500, CPULimMilli: 1000, CPUReqMilli: 500, MemUsageBytes: 1000 * Mi, MemLimBytes: 1024 * Mi, MemReqBytes: 1024 * Mi},
			wantCPUDir: Hold,
			wantMemDir: Up, wantChgMem: false, wantMemLim: 1024 * Mi, wantBounce: true,
		},
		{
			name:       "mem idle but usage above shrink target -> hold (never OOM on shrink)",
			s:          Sample{CPUUsageMilli: 500, CPULimMilli: 1000, CPUReqMilli: 500, MemUsageBytes: 700 * Mi, MemLimBytes: 1024 * Mi, MemReqBytes: 512 * Mi},
			wantCPUDir: Hold,
			// usage/limit = 0.68 -> not <= 0.30, so Hold anyway
			wantMemDir: Hold, wantChgMem: false, wantMemLim: 1024 * Mi,
		},
		{
			name:       "unbounded cpu limit -> no pressure, hold",
			s:          Sample{CPUUsageMilli: 5000, CPULimMilli: 0, CPUReqMilli: 250, MemUsageBytes: 100 * Mi, MemLimBytes: 512 * Mi, MemReqBytes: 256 * Mi},
			wantCPUDir: Hold, wantChgCPU: false,
			wantMemDir: Down, wantChgMem: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			d := Decide(tc.s, b)
			if d.CPUDir != tc.wantCPUDir {
				t.Errorf("CPUDir = %v, want %v", d.CPUDir, tc.wantCPUDir)
			}
			if d.MemDir != tc.wantMemDir {
				t.Errorf("MemDir = %v, want %v", d.MemDir, tc.wantMemDir)
			}
			if d.ChangeCPU != tc.wantChgCPU {
				t.Errorf("ChangeCPU = %v, want %v", d.ChangeCPU, tc.wantChgCPU)
			}
			if d.ChangeMem != tc.wantChgMem {
				t.Errorf("ChangeMem = %v, want %v", d.ChangeMem, tc.wantChgMem)
			}
			if tc.wantCPULim != 0 && d.NewCPULimMilli != tc.wantCPULim {
				t.Errorf("NewCPULimMilli = %d, want %d", d.NewCPULimMilli, tc.wantCPULim)
			}
			if tc.wantMemLim != 0 && d.NewMemLimBytes != tc.wantMemLim {
				t.Errorf("NewMemLimBytes = %d, want %d", d.NewMemLimBytes, tc.wantMemLim)
			}
			if d.NeedsBounce != tc.wantBounce {
				t.Errorf("NeedsBounce = %v, want %v", d.NeedsBounce, tc.wantBounce)
			}
		})
	}
}

// The clamp never lets a resize escape [min,max], and req never exceeds lim.
func TestDecideClampInvariants(t *testing.T) {
	b := stdBounds()
	// A giant step must still clamp to max, and req <= lim.
	b.CPUStepMilli = 100000
	d := Decide(Sample{CPUUsageMilli: 999, CPULimMilli: 1000, CPUReqMilli: 1000, MemLimBytes: 512 << 20, MemReqBytes: 256 << 20}, b)
	if d.NewCPULimMilli != b.MaxCPUMilli {
		t.Fatalf("cpu limit escaped max: %d", d.NewCPULimMilli)
	}
	if d.NewCPUReqMilli > d.NewCPULimMilli {
		t.Fatalf("cpu req %d > lim %d", d.NewCPUReqMilli, d.NewCPULimMilli)
	}
}
