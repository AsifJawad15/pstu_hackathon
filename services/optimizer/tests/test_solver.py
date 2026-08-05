from __future__ import annotations

import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from optimizer.solver import InvalidOptimizationRequest, solve_bundle


class BundleSolverTests(unittest.TestCase):
    def test_exact_solver_beats_greedy_specialist_choice(self) -> None:
        result = solve_bundle({
            "deadlineMs": 100,
            "requiredCapacity": 2,
            "requiredCapabilities": ["ALS", "RESCUE"],
            "candidates": [
                {"resourceId": "all-rounder", "cost": 100, "capacity": 2, "capabilities": ["ALS", "RESCUE"]},
                {"resourceId": "als", "cost": 25, "capacity": 1, "capabilities": ["ALS"]},
                {"resourceId": "rescue", "cost": 25, "capacity": 1, "capabilities": ["RESCUE"]},
            ],
        })
        self.assertTrue(result["feasible"])
        self.assertTrue(result["optimal"])
        self.assertEqual(result["selectedResourceIds"], ["als", "rescue"])
        self.assertEqual(result["objective"], 50)

    def test_one_resource_can_cover_capacity_and_multiple_capabilities(self) -> None:
        result = solve_bundle({
            "deadlineMs": 50,
            "requiredCapacity": 8,
            "requiredCapabilities": ["ALS", "AIR_EVAC"],
            "candidates": [
                {"resourceId": "helicopter", "cost": 80, "capacity": 8, "capabilities": ["ALS", "AIR_EVAC"]},
                {"resourceId": "ambulance", "cost": 20, "capacity": 2, "capabilities": ["ALS"]},
            ],
        })
        self.assertEqual(result["selectedResourceIds"], ["helicopter"])

    def test_no_feasible_bundle_is_explicit(self) -> None:
        result = solve_bundle({
            "deadlineMs": 50, "requiredCapacity": 2, "requiredCapabilities": ["BURN"],
            "candidates": [{"resourceId": "unit", "cost": 1, "capacity": 5, "capabilities": ["ALS"]}],
        })
        self.assertFalse(result["feasible"])
        self.assertEqual(result["algorithm"], "NO_FEASIBLE_BUNDLE")

    def test_tie_breaking_is_deterministic(self) -> None:
        payload = {
            "deadlineMs": 50, "requiredCapacity": 1, "requiredCapabilities": ["ALS"],
            "candidates": [
                {"resourceId": "z-unit", "cost": 10, "capacity": 1, "capabilities": ["ALS"]},
                {"resourceId": "a-unit", "cost": 10, "capacity": 1, "capabilities": ["ALS"]},
            ],
        }
        first = solve_bundle(payload)
        second = solve_bundle(payload)
        self.assertEqual(first["selectedResourceIds"], ["a-unit"])
        first.pop("durationMs")
        second.pop("durationMs")
        self.assertEqual(first, second)

    def test_duplicate_resource_is_rejected(self) -> None:
        with self.assertRaises(InvalidOptimizationRequest):
            solve_bundle({
                "deadlineMs": 50, "requiredCapacity": 1, "requiredCapabilities": ["ALS"],
                "candidates": [
                    {"resourceId": "same", "cost": 1, "capacity": 1, "capabilities": ["ALS"]},
                    {"resourceId": "same", "cost": 1, "capacity": 1, "capabilities": ["ALS"]},
                ],
            })


if __name__ == "__main__":
    unittest.main()
