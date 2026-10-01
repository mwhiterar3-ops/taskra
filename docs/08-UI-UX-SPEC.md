# Taskra — UI/UX Specification

Build a focused professional Web3 application.

## Primary routes

/
 /tasks
 /tasks/new
 /tasks/:id
 /dashboard/client
 /dashboard/developer
 /profile/:wallet

## Client flow

Connect wallet
→ Create task
→ Fund escrow
→ Monitor task
→ Review evidence
→ Approve/reject
→ View settlement

## Developer flow

Connect wallet
→ Browse tasks
→ View task
→ Accept
→ Submit evidence
→ Monitor review
→ Receive payment
→ View reputation

## Required transaction states

- wallet disconnected
- connecting
- awaiting signature
- signing
- submitted
- confirming
- confirmed
- failed

Show transaction signatures/explorer links where appropriate.

Never display success when the underlying blockchain action failed.

Keep the UI centered around the core economic loop. Do not build social/productivity features outside the MVP.
