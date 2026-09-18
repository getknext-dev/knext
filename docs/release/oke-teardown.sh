#!/usr/bin/env bash
# OKE (knext2, me-abudhabi-1) full teardown — HUMAN-RUN ONLY.
#
# Cluster/infra teardown is human-gated by .claude/hooks/block-dangerous-bash.sh
# (ADR-0001: the operator is the single source of truth for cluster state). An
# agent wrote this; a human runs it. Review, then execute.
#
# Order matters: cluster first (cascades the node pool, terminates worker nodes,
# detaches the block volumes) -> load balancers -> volumes -> VCN. Deleting the
# VCN before its LBs/subnets are gone fails on dependent resources.
#
# Billing note: nodes + LBs + block volumes are the cost. A VCN itself is ~free
# (only its NAT gateway bills a little), so the VCN can wait for the Console.
set -uo pipefail
export SUPPRESS_LABEL_WARNING=True

CID=ocid1.cluster.oc1.me-abudhabi-1.aaaaaaaa57sfybjid6zpizgujsrclprwwlff6lhntvkajhngbckmva7v7zvq
VCN=ocid1.vcn.oc1.me-abudhabi-1.amaaaaaafgi6s3iavoa6dxkeiex3rcgbqui4jyihkbv3irlhrqvfjtmf26ra

# k8s-created LoadBalancers (bill separately; NOT removed by cluster delete)
LBS=(
  ocid1.loadbalancer.oc1.me-abudhabi-1.aaaaaaaa23r47ykyroh5ogfx5n6euwhhwnbet3clvdbirgm62xoygr3ebuaa
  ocid1.loadbalancer.oc1.me-abudhabi-1.aaaaaaaagzr2kesbmibuslc4x2lyyorhj3a2mmyi4f7kt5epnlwoqyr535dq
  ocid1.loadbalancer.oc1.me-abudhabi-1.aaaaaaaafvlqiwoxbaqb4q3gcwk3sshlmb6hg2ri4tltm2imykckylahtcla
  ocid1.loadbalancer.oc1.me-abudhabi-1.aaaaaaaalqvkhzezpojsb5ycvy5es5uyb74o6kj6efm5hwv4cu2xoyliccoa
)
# CSI block volumes (from PVCs; detach once nodes terminate, then deletable)
VOLS=(
  ocid1.volume.oc1.me-abudhabi-1.abqxkljrhkkkx33krkzfdv5zuvi2wyjzwyofdut4eq64z7jrqzyib7hyeqiq
  ocid1.volume.oc1.me-abudhabi-1.abqxkljrtyhsatsqdk4hidmd4fpnxkc5bue2obrxaq3dkoe5e5l4buc3k6qq
  ocid1.volume.oc1.me-abudhabi-1.abqxkljrlexggbijylwo3udcr22pxga5oe6g2bz3jvsfsk4dgm54a7kbqj4a
  ocid1.volume.oc1.me-abudhabi-1.abqxkljro6vjcl4u3mdldx22bkr3nx55k24rw7s6c6drsxfikm6o5tisyjbq
  ocid1.volume.oc1.me-abudhabi-1.abqxkljrueheyu4546mmnteyoz2hofrovtsslrkoekblvddvrohwwdbvbywq
  ocid1.volume.oc1.me-abudhabi-1.abqxkljrongzwyszs46u3rmhoz4qushvbbpbrunkhvrp5nqwuiybz3a53ewq
  ocid1.volume.oc1.me-abudhabi-1.abqxkljrjxzcxc7zhs25jsrwfk25vw2rardcrqa4nxgii6uk7bqubxkzi3qa
)

echo "== 1. delete cluster (cascades node pool, terminates nodes) =="
oci ce cluster delete --cluster-id "$CID" --force

echo "== 2. delete ${#LBS[@]} load balancers =="
for LB in "${LBS[@]}"; do oci lb load-balancer delete --load-balancer-id "$LB" --force; done

echo "== 3. delete ${#VOLS[@]} block volumes (re-run this loop if any say 'attached' — nodes still terminating) =="
for V in "${VOLS[@]}"; do oci bv volume delete --volume-id "$V" --force || echo "  retry '$V' once the cluster is fully deleted"; done

echo "== 4. VCN =="
echo "Console (easiest): Networking -> Virtual Cloud Networks -> knext VCN -> Terminate (cascades subnets/gateways/route tables/security lists)."
echo "CLI (only after subnets/gateways removed):  oci network vcn delete --vcn-id $VCN --force"

echo "== done. Verify zero billable: Console -> Cost Analysis, and empty per-service lists. Then close the tenancy (Tenancy Management -> Close Tenancy). =="
