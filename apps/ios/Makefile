# Iris Workplace for iPhone. `make help` lists the targets.
export DEVELOPER_DIR := /Applications/Xcode.app/Contents/Developer

PROJECT   := IrisWorkplace.xcodeproj
SCHEME    := IrisWorkplace
DD        := build/dd
SIM       ?= iPhone 17
DEVICE    ?= 00008140-001E50C61487001C
BUNDLE    := com.irisforu.workplace
MOCK_PORT ?= 4399

.PHONY: help gen fixtures check build test sim-build sim-run mock device shots

help:
	@echo "gen        regenerate the Xcode project from project.yml"
	@echo "fixtures   regenerate fixtures/*.json from mock/data.mjs"
	@echo "check      compare the Swift models with the TypeScript contract"
	@echo "test       check + unit tests on the simulator"
	@echo "sim-run    build, install and launch on the simulator against the mock (needs 'make mock' running)"
	@echo "mock       run the mock Workplace on 0.0.0.0:$(MOCK_PORT)"
	@echo "device     build, install and launch on the owner's iPhone"
	@echo "shots      screenshot every screen on the simulator (needs 'make mock' running)"

gen:
	xcodegen generate

fixtures:
	node scripts/write-fixtures.mjs

check:
	node scripts/check-contract.mjs

build: gen
	xcodebuild -project $(PROJECT) -scheme $(SCHEME) -destination 'platform=iOS Simulator,name=$(SIM)' -derivedDataPath $(DD) build 2>&1 | grep -E "error:|BUILD"

uitest: gen
	xcodebuild -project $(PROJECT) -scheme IrisWorkplaceUI -destination 'platform=iOS Simulator,name=$(SIM)' -derivedDataPath $(DD) test 2>&1 | grep -E "error:|Executed|Test Suite .All tests.|failed" | grep -v hapticpattern

test: check gen
	xcodebuild -project $(PROJECT) -scheme $(SCHEME) -destination 'platform=iOS Simulator,name=$(SIM)' -derivedDataPath $(DD) test 2>&1 | grep -E "error:|Executed|Test Suite 'All tests'|failed" | grep -v hapticpattern

mock:
	node mock/server.mjs --host 0.0.0.0 --port $(MOCK_PORT) --reusable-code

sim-run: build
	xcrun simctl boot "$(SIM)" 2>/dev/null || true
	open -a Simulator
	xcrun simctl install "$(SIM)" $(DD)/Build/Products/Debug-iphonesimulator/IrisWorkplace.app
	xcrun simctl terminate "$(SIM)" $(BUNDLE) 2>/dev/null || true
	SIMCTL_CHILD_WORKPLACE_URL=127.0.0.1:$(MOCK_PORT) SIMCTL_CHILD_WORKPLACE_TOKEN=mock-token-0123456789abcdef xcrun simctl launch "$(SIM)" $(BUNDLE)

shots:
	./scripts/shots.sh "$(SIM)"

device: gen
	xcodebuild -project $(PROJECT) -scheme $(SCHEME) -configuration Debug -destination id=$(DEVICE) -allowProvisioningUpdates -derivedDataPath $(DD) build 2>&1 | grep -E "error:|BUILD"
	xcrun devicectl device install app --device $(DEVICE) $(DD)/Build/Products/Debug-iphoneos/IrisWorkplace.app
	xcrun devicectl device process launch --terminate-existing --device $(DEVICE) $(BUNDLE)
