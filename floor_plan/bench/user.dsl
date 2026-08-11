seed 10
canvas 1400x1100
ratio_max 5:3
side_min 175
cwl 125

# Areas (1 sqm = 10,000 sq cm)
room loud area=300000 ratio_max=3:1
room guest_bath area=40000
room hallway_1 ratio_max=1:6
room hallway_2 ratio_max=1:6
room office area=80000
room kitchen area=150000
room live_dine area=400000
room main_bath area=80000
room parents area=180000

# Food storage
room pantry area=50000

# Heat pump and washing machine
room utility area=40000

room dressing area=30000

# Groups
hallways = [hallway_1, hallway_2]
meal = [kitchen, live_dine]
bath = [main_bath, guest_bath]

inside loud {
    room child_1 area=100000
    room child_2 area=100000
    room child_3 area=100000
    [child_1, child_2, child_3] connect any hallways required
}

# Connectivity
hallway_1 connect hallway_2 required
hallways at edge weight=200

parents connect dressing required

dressing enclosed
pantry enclosed

parents connect main_bath required

# Main bath is for parents only
main_bath far hallways weight=2

[all but hallways, pantry, dressing, main_bath] connect any hallways required

# Dining bridges kitchen and living
[live_dine, pantry] connect kitchen required

[office, parents] far loud

# Must be able to open window for fresh
# air after cooking, shower and sleep
air_sun = meal + bath + [parents]

air_sun at edge required

parents not at south required

# Sun goes down west (bad for TV time)
live_dine not at west
live_dine not at south west required

# Office on the quiet north, west side
# (no blinding sun in morning or noon)
office at north west required
