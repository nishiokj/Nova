# Database Audit Report - Evidence Tables

**Date**: 2025-01-09
**Purpose**: Verify actual data state in evidence tables for memory-injector V2

## Executive Summary

This audit reveals a **critical data gap**: only the base `entity_graph.entities` table contains data, while all specialized evidence tables required by memory-injector V2 are empty. This explains why V2 is falling back to V1 - there is no evidence data to process.

## Table Row Counts

| Table | Count | Status |
|-------|-------|--------|
| `entity_graph.entities` | 7,708 | ✅ Populated |
| `config_facts` | 0 | ❌ Empty |
| `runtime_facts` | 0 | ❌ Empty |
| `test_specs` | 0 | ❌ Empty |
| `coding_preferences` | 0 | ❌ Empty |
| `coding_decisions` | 0 | ❌ Empty |

## Sample Records Analysis

### 1. `entity_graph.entities` (7,708 records)

**Schema**: `id | kind | name | filepath | start_line | end_line | exported | async | raw_text`

**Sample Records**:
```
```

**Data Quality Assessment**:
- ✅ Well-structured entity data with proper schema
- ✅ Contains both file and function entities
- ✅ Has source code location (filepath, line numbers)
- ✅ Includes raw text for code bodies
- ⚠️ Limited to code structure - lacks semantic knowledge
- ⚠️ No behavioral insights, configuration knowledge, or decision rationale

### 2. `config_facts` (0 records)

**Expected Content**: Configuration patterns, environment-specific setups, feature flags, dependency injection patterns

**Status**: ❌ **EMPTY** - No configuration knowledge captured

**Impact on Memory-Injection**: V2 cannot access configuration-aware memories

### 3. `runtime_facts` (0 records)

**Expected Content**: Execution patterns, lifecycle behaviors, runtime constraints, performance characteristics

**Status**: ❌ **EMPTY** - No runtime behavior knowledge captured

**Impact on Memory-Injection**: V2 cannot access runtime-aware memories

### 4. `test_specs` (0 records)

**Expected Content**: Test coverage, edge cases, validation rules, expected behaviors

**Status**: ❌ **EMPTY** - No testing knowledge captured

**Impact on Memory-Injection**: V2 cannot access test-informed memories

### 5. `coding_preferences` (0 records)

**Expected Content**: Architectural patterns, naming conventions, style choices, design patterns

**Status**: ❌ **EMPTY** - No preference knowledge captured

**Impact on Memory-Injection**: V2 cannot access preference-aware memories

### 6. `coding_decisions` (0 records)

**Expected Content**: Rationale behind architectural choices, trade-offs, historical decisions

**Status**: ❌ **EMPTY** - No decision knowledge captured

**Impact on Memory-Injection**: V2 cannot access decision-aware memories

## Root Cause Analysis

### Why V2 Falls Back to V1

Memory-injector V2 is designed to inject **rich, evidence-based memories** by:

1. Querying specialized evidence tables (config_facts, runtime_facts, etc.)
2. Building contextual memory bundles from diverse data sources
3. Providing memories with deep semantic understanding

However, since **all specialized evidence tables are empty**, V2 cannot build quality memories. The fallback logic triggers, reverting to V1 which only uses `entity_graph.entities` (the only available data).

### Data Gap Severity

**CRITICAL**: The evidence pipeline is either:
- Not running at all
- Running but failing silently
- Writing to wrong tables/locations
- Missing data ingestion tasks

## Recommended Actions

### Immediate (Critical Path)

1. **Locate Evidence Pipeline Code**
   - Find the data ingestion/processing scripts
   - Identify why evidence tables are empty
   - Check for errors in logs

2. **Verify Pipeline Execution**
   - Check if sync tasks exist for evidence sources
   - Run `sync-api-cli tasks list` to see active tasks
   - Check job history with `sync-api-cli jobs list`

3. **Schema Validation**
   - Use `schema-cli tables describe <table>` to verify table structures
   - Confirm column names match expected schema

4. **Data Source Investigation**
   - Identify where evidence data should come from
   - Check if source systems are available/accessible
   - Verify connection strings and credentials

### Secondary (Data Quality)

Once pipeline is running:
5. **Add Data Quality Checks**
   - Verify row counts after each sync
   - Validate data completeness
   - Check for nulls/corrupted records

6. **Monitor Evidence Tables**
   - Set up automated monitoring
   - Alert on zero-row conditions
   - Track growth patterns

## Next Steps for Memory-Injector

### Short-term
- Keep V1 fallback active (necessary until evidence data exists)
- Add logging to track when and why fallback occurs
- Document the data dependency clearly

### Medium-term
- Once evidence data is available, test V2 with real data
- Compare memory quality between V1 and V2
- Validate evidence-based memory construction

### Long-term
- Remove V1 fallback after V2 is proven
- Add evidence table health checks to startup
- Create evidence data dashboards

## Commands Used for Audit

```bash
# Row counts
bun run scripts/sql-cli.ts "SELECT COUNT(*) FROM entity_graph.entities"
bun run scripts/sql-cli.ts "SELECT COUNT(*) FROM config_facts"
bun run scripts/sql-cli.ts "SELECT COUNT(*) FROM runtime_facts"
bun run scripts/sql-cli.ts "SELECT COUNT(*) FROM test_specs"
bun run scripts/sql-cli.ts "SELECT COUNT(*) FROM coding_preferences"
bun run scripts/sql-cli.ts "SELECT COUNT(*) FROM coding_decisions"

# Sample records
bun run scripts/sql-cli.ts "SELECT * FROM entity_graph.entities LIMIT 5"
bun run scripts/sql-cli.ts "SELECT * FROM config_facts LIMIT 5"
bun run scripts/sql-cli.ts "SELECT * FROM runtime_facts LIMIT 5"
bun run scripts/sql-cli.ts "SELECT * FROM test_specs LIMIT 5"
bun run scripts/sql-cli.ts "SELECT * FROM coding_preferences LIMIT 5"
bun run scripts/sql-cli.ts "SELECT * FROM coding_decisions LIMIT 5"
```

## Conclusion

The evidence data pipeline is **non-functional** - only base entity data exists, but none of the specialized evidence tables required for V2 memories are populated. This is the root cause of the V2 fallback issue. Fixing the evidence data pipeline is the highest priority for enabling quality memory injection.
