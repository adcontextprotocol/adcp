## Objectives

The goal of the Agentic Media Buying Protocol (ACP:Buy) is to provide a mechanism for an orchestrator to facilitate a media buy on a publisher on behalf of a principal.

In the ACP:Buy protocol, a "media package" is a collaborative combination of placements, data, creative, and targeting, delivered at a mutually-agreeable price between the principal and the publisher. A media package represents a hypothesis that can be tested through some form of measurement, whether econometric, predictive, or observed. For ACP:Buy to work properly, the principal must provide indexed measurement data on a regular basis. This enables the publisher to adjust packages to deliver optimal outcomes. Additionally, for ACP:Buy to work properly, all media packages must have sufficient exposures to facilitate measurement in a reasonable time.

Media packages are executed by the publisher. The principal can contribute data and strategies to the media buy for the publisher to use in media packages. For instance, a principal may have first-party audience data. The publisher could use this to create a media package, potentially optimizing delivery using its own ata as well.

## Protocol Overview

The protocol works as follows:

Phase 1: Proposal
The orchestrator requests a proposal from the publisher by providing a brief that describes objectives, target audience, available signals, measurement requirements, and budget range. The publisher responds with packages that match the brief as well as the creative assets required for each.

The proposal phase may include multiple iterations where the principal requests changes or updates to the proposed packages.

Phase 2: Acceptance
When the principal is ready to proceed with the buy, the orchestrator accepts the proposal, sets flight dates, and finalizes budget. The publisher sets up the media buy.

Phase 3: Creative Delivery
For the media buy to go live, the principal must provide the necessary creative assets (often requiring approval by the publisher). For publishers that generate or adapt creative on behalf of the principal, creatives may require approval by the buyer.

The buyer should provide a mechanism (third-party ad server, measurement tag, log-level data endpoint, clean room) to receive exposure data from the publisher.

Phase 4: Launch
The media buy goes live at the beginning of the flight.

Phase 5: Feedback Loop
On a regular basis (ideally daily), the principal should share a report on performance vs index by package, including the time range for the measured exposures. The publisher can use this performance data to optimize packages.

The publisher should provide billable data on delivery by package to date, as well as media metrics like views, clicks, and completions.

The principal may also use this feedback loop to request changes to packages, including updating frequency caps, budgets, pacing, and creative. The principal may also request new packages or iterations on the active packages.

Phase 6: Wrap-up
At the end of the flight dates, the orchestrator should request a final delivery report from the publisher. This should correspond with the invoice that the publisher sends to the principal. Reconciliation and payment are not in scope for this protocol for now.

## Agentic Execution Engine

The goal of the ACP:Buy protocol is to combine the impression-level real-time decisioning capabilities of real-time bidding (RTB) with the scale, data protection, and customizability of traditional media buys. The ACP:Buy protocol is not dependent upon impression-level decisioning and applies equally well to offline media buys (like linear television or terrestrial radio). However, when decisions are at an impression level, ACP:Buy can be combined with real-time agents to make more precise decisions.

The ability to provide real-time signals at the impression level also means that the principal does not have to synchronize audiences ahead of time with a publisher, nor send raw audience data to a publisher. The signals that come from the AEE to the publisher are identified only as eligible or ineligible. For instance, an agent may be applying a frequency cap, brand safety controls, and an audience. An ineligible impression for this particular agent might be over the cap, not suitable for the brand, or not in the audience.

### AEE Protocol Overview
1. The decisioning platform makes an OpenRTB 2.6 request to the AEE. This request may include a list of packages.
2. The AEE responds with a list of signals (for instance: nestle_rts3, tccc_schweppes_inm), and may specify a list of ineligible packages.
3. Packages that specify a signal as "required" must have that signal present to deliver. Packages that specify a signal as "excluded" must not deliver if that signal is present. A package may have more than one required and/or excluded signal. Any package marked ineligible must not deliver.

### AEE Containerization and Trusted Execution
An AEE may be deployed in a public cloud (as with traditional third-party ad tech) or in a secure enclave or trusted execution environment (TEE). An AEE may be able piggyback on existing services like Prebid Server to integrate into ad servers. We look forward to collaborating with Prebid.org and other industry organizations to provide reference implmentations and/or reusable modules to simplify deployment by publishers.