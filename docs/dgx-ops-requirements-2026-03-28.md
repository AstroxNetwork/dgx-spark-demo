# DGX Ops Requirements

Date: 2026-03-28

## Goal

Today the priority is not TTS experimentation. The priority is making the DGX demo stack restartable, reachable, and operable from a new MacBook with minimal assumptions.

## Required Outcomes

### 1. DGX reboot safety

After a DGX shutdown or reboot, all 6 services must be able to come back up completely:

1. Ollama 35B
2. qwen-tts-rs
3. vLLM Qwen ASR
4. OpenViking
5. OpenClaw gateway
6. OneBox preview

This must be verifiable with a single health-check flow after restart.

### 2. No internal dependency on a fixed LAN IP

The DGX machine may change IP.

Requirements:

- Internal service-to-service wiring must not depend on a hard-coded LAN IP.
- External browser entry must still work through:
  - `https://<current-ip>:8443`
  - `https://<current-ip>:8444`
- The only thing an operator should need to know is the current DGX IP or hostname.

### 3. Certificate onboarding for a new MacBook

A new MacBook that wants to access OpenClaw must be able to get and install the DGX certificate.

Required capability:

- A script to fetch the certificate from DGX, or
- A script to install an already-fetched certificate onto macOS

Preferred result:

- A scripted flow that works on a fresh MacBook without manual certificate hunting.

### 4. New MacBook remote ops scripts

The new MacBook must have 3 remote-operation scripts:

1. Check 6-service status
2. Restart and bring up 6 services
3. Restart only the OpenClaw gateway

These scripts must operate remotely against DGX and must not rely on editing local repo state on the DGX by hand.

## Acceptance Criteria

The work is only complete when all of the following are true:

- DGX can be rebooted and all 6 services come back.
- The 6-service check script passes after reboot.
- No runtime startup path requires a fixed `192.168.x.x`-style address.
- `8443` and `8444` are reachable from a browser using the current DGX IP.
- A new MacBook can obtain and install the required certificate with scripts.
- The new MacBook has all 3 remote scripts ready and documented.

## Implementation Plan

### Step 1. Lock the DGX-side startup chain

Audit and fix:

- `scripts/start_dgx_runtime.sh`
- `scripts/start_dgx_stack.sh`
- `scripts/start_onebox.sh`
- `scripts/check_dgx_stack.sh`
- related `systemd` units

Focus:

- restart behavior
- startup ordering
- repo path assumptions
- service health verification

### Step 2. Remove fixed-IP assumptions

Audit all startup, proxy, and health-check paths for:

- hard-coded LAN IPs
- environment defaults that assume one DGX address
- browser-facing URLs that should be host/IP relative

Keep:

- fixed local ports
- loopback access between services on DGX

Avoid:

- embedding one specific DGX LAN address into code or scripts

### Step 3. Prepare certificate flow for a new MacBook

Add scripts for:

- downloading or exporting the certificate from DGX
- installing the certificate into macOS trust/keychain

Document:

- expected file location
- exact command to run on a new machine

### Step 4. Prepare the 3 MacBook remote ops scripts

Provide scripts for:

1. health check
2. full restart / bring-up
3. OpenClaw-only restart

Inputs should be minimal:

- current DGX IP or hostname
- optional SSH user
- optional password or existing SSH auth

### Step 5. End-to-end proof

Final validation must include:

1. Run the full bring-up script remotely.
2. Run the health-check script remotely.
3. Verify `8443` and `8444` in browser form using the current DGX IP.
4. Verify certificate retrieval / install flow on a clean or clean-like MacBook setup.

## Non-Goals For This Pass

The following are not part of this pass unless they directly block restartability or access:

- Trevor streaming experiments
- TTS quality tuning
- sentence-stream protocol evolution
- front-end playback refinements

## Working Principle

The stack must be operable by knowing only:

- where the DGX is now
- how to SSH to it

Everything else should be encoded in scripts, fixed service ports, service-local loopback wiring, and documented operator steps.
