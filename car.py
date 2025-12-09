"""
car.py

Dataclasses representing a car and its common data fields.
Includes nested dataclasses for Engine, Dimensions, Performance, and more.
"""
from dataclasses import dataclass, field, asdict
from typing import Optional, List, Dict
from datetime import date, datetime


@dataclass
class Engine:
    engine_type: Optional[str] = None  # e.g., "I4", "V6", "Electric"
    displacement_l: Optional[float] = None  # liters
    cylinders: Optional[int] = None
    horsepower: Optional[int] = None
    torque_nm: Optional[int] = None
    turbo: Optional[bool] = None


@dataclass
class Transmission:
    type: Optional[str] = None  # e.g., "Automatic", "Manual", "CVT", "DCT"
    gears: Optional[int] = None
    final_drive_ratio: Optional[float] = None


@dataclass
class Dimensions:
    length_mm: Optional[int] = None
    width_mm: Optional[int] = None
    height_mm: Optional[int] = None
    wheelbase_mm: Optional[int] = None
    curb_weight_kg: Optional[float] = None


@dataclass
class Performance:
    top_speed_kph: Optional[int] = None
    zero_to_100_kph_s: Optional[float] = None
    fuel_economy_city_l_per_100km: Optional[float] = None
    fuel_economy_hwy_l_per_100km: Optional[float] = None
    fuel_economy_combined_l_per_100km: Optional[float] = None


@dataclass
class TireWheel:
    tire_size: Optional[str] = None  # e.g., "225/45R17"
    wheel_size_in: Optional[float] = None  # e.g., 17
    spare_included: Optional[bool] = None


@dataclass
class SafetyInfo:
    airbags: Optional[int] = None
    abs: Optional[bool] = None
    traction_control: Optional[bool] = None
    stability_control: Optional[bool] = None
    lane_assist: Optional[bool] = None
    automatic_emergency_braking: Optional[bool] = None
    blind_spot_monitor: Optional[bool] = None
    other: List[str] = field(default_factory=list)


@dataclass
class Car:
    # Basic identity
    make: Optional[str] = None
    model: Optional[str] = None
    trim: Optional[str] = None
    year: Optional[int] = None
    vin: Optional[str] = None
    msrp_currency: Optional[str] = "USD"
    msrp: Optional[float] = None

    # Physical attributes
    color: Optional[str] = None
    body_style: Optional[str] = None  # e.g., "Sedan", "SUV", "Hatchback"
    doors: Optional[int] = None
    seating_capacity: Optional[int] = None

    # Mechanical
    engine: Engine = field(default_factory=Engine)
    transmission: Transmission = field(default_factory=Transmission)
    drivetrain: Optional[str] = None  # e.g., "FWD", "RWD", "AWD"
    fuel_type: Optional[str] = None  # e.g., "Gasoline", "Diesel", "Electric", "Hybrid"
    fuel_tank_capacity_l: Optional[float] = None

    # Dimensions & performance
    dimensions: Dimensions = field(default_factory=Dimensions)
    performance: Performance = field(default_factory=Performance)
    towing_capacity_kg: Optional[int] = None
    cargo_volume_l: Optional[float] = None
    trunk_capacity_l: Optional[float] = None

    # Wheels & tires
    tire_wheel: TireWheel = field(default_factory=TireWheel)

    # Safety & convenience
    safety: SafetyInfo = field(default_factory=SafetyInfo)
    infotainment: List[str] = field(default_factory=list)
    convenience_features: List[str] = field(default_factory=list)
    packages: List[str] = field(default_factory=list)

    # Production & registration
    manufacturer: Optional[str] = None
    production_date: Optional[date] = None
    registration_plate: Optional[str] = None
    registration_country: Optional[str] = None

    # Ownership & maintenance
    current_owner: Optional[str] = None
    previous_owners: List[str] = field(default_factory=list)
    service_history: List[Dict[str, str]] = field(default_factory=list)  # e.g., [{"date": "2020-01-01", "service": "oil change"}]

    # Misc
    notes: Optional[str] = None
    additional_attributes: Dict[str, object] = field(default_factory=dict)

    def to_dict(self) -> Dict:
        """Return a dictionary representation. Dates converted to ISO strings."""
        result = asdict(self)
        # convert date objects
        pd = result.get("production_date")
        if isinstance(pd, (date, datetime)):
            result["production_date"] = pd.isoformat()
        return result

    @classmethod
    def from_dict(cls, data: Dict) -> "Car":
        """Construct a Car from a dictionary, attempting to map nested structures."""
        # shallow copy
        data = dict(data)

        # handle nested dataclasses
        if "engine" in data and isinstance(data["engine"], dict):
            data["engine"] = Engine(**data["engine"])
        if "transmission" in data and isinstance(data["transmission"], dict):
            data["transmission"] = Transmission(**data["transmission"])
        if "dimensions" in data and isinstance(data["dimensions"], dict):
            data["dimensions"] = Dimensions(**data["dimensions"])
        if "performance" in data and isinstance(data["performance"], dict):
            data["performance"] = Performance(**data["performance"])
        if "tire_wheel" in data and isinstance(data["tire_wheel"], dict):
            data["tire_wheel"] = TireWheel(**data["tire_wheel"])
        if "safety" in data and isinstance(data["safety"], dict):
            data["safety"] = SafetyInfo(**data["safety"])

        # parse production_date if provided as string
        pd = data.get("production_date")
        if isinstance(pd, str):
            try:
                data["production_date"] = date.fromisoformat(pd)
            except Exception:
                data["production_date"] = None

        return cls(**data)

    def validate(self) -> List[str]:
        """Return a list of validation error messages (empty if valid).
        This is lightweight and can be extended.
        """
        errors = []
        if self.year is not None:
            if self.year < 1886 or self.year > (date.today().year + 2):
                errors.append("year out of realistic range")
        if self.vin is not None and len(self.vin) not in (0, 17):
            # VINs are typically 17 characters; allow empty
            errors.append("vin length is unexpected (expected 17)")
        if self.seating_capacity is not None and self.seating_capacity <= 0:
            errors.append("seating_capacity must be > 0")
        return errors

    def __str__(self) -> str:
        parts = [p for p in [self.make, self.model, str(self.year) if self.year else None] if p]
        return " ".join(parts) or "Car()"


# Example usage
if __name__ == "__main__":
    example = Car(
        make="Toyota",
        model="Camry",
        trim="XSE",
        year=2023,
        vin="12345678901234567",
        color="Super White",
        body_style="Sedan",
        doors=4,
        seating_capacity=5,
        engine=Engine(engine_type="I4", displacement_l=2.5, cylinders=4, horsepower=203, torque_nm=250, turbo=False),
        transmission=Transmission(type="Automatic", gears=8),
        drivetrain="FWD",
        fuel_type="Gasoline",
        msrp=31000.0,
        msrp_currency="USD",
        production_date=date(2022, 9, 1),
        infotainment=["Apple CarPlay", "Android Auto", "8-inch touchscreen"],
        convenience_features=["Keyless entry", "Push-button start"],
        safety=SafetyInfo(airbags=8, abs=True, traction_control=True, stability_control=True, lane_assist=True),
    )
    print(example)
    print(example.to_dict())
