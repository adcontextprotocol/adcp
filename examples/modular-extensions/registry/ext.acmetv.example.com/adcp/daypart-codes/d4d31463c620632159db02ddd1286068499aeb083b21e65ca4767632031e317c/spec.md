# AcmeTV daypart codes

This document is the specification of the vendor extension
`https://ext.acmetv.example.com/adcp/daypart-codes`, version 2.6.0. AcmeTV owns it. The
extension digest covers this file.

## Conventions

The key words "MUST", "MUST NOT", "SHOULD", and "MAY" in this document are to be interpreted
as described in BCP 14 (RFC 2119 and RFC 8174) when, and only when, they appear in all
capitals. Each requirement is a rule with an ID, and names what enforces it.

## Overview

AcmeTV labels its pricing options with its own daypart grid. The labels are informational:
a buyer without this extension loses nothing it needs to transact. The extension attaches at
the `pricing_option` extension point (policy `flag`) with the definition `DaypartCodes`.

## Rules

#### DP-R1: A buyer without the extension keeps the option

A buyer that does not understand this extension MUST ignore the daypart codes and MUST keep the
pricing option.

Enforced by: kernel (extension point `pricing_option`, policy `flag`, entry not flagged).

#### DP-R2: Codes and times follow the grid format

Each daypart MUST have a `code` of two capital letters and a digit, and `start` and `end`
times in the 24-hour `HH:MM` format.

Enforced by: schema (`DaypartCodes`).

#### DP-R3: The codes are never must-understand

AcmeTV MUST NOT flag a daypart-codes entry `must_understand`.

Enforced by: conformance only.
