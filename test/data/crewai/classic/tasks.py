from crewai import Task
from textwrap import dedent


class TripTasks:
    def identify_task(self, agent, origin, cities, interests, travel_range):
        return Task(
            description=dedent(
                f"""
                Analyze and select the best city for the trip based
                on specific criteria such as weather patterns.
                Traveling from: {origin}
                """
            ),
            expected_output="A detailed report on the chosen city",
            agent=agent,
        )

    def gather_task(self, agent, origin, interests, travel_range):
        return Task(
            description="Compile an in-depth guide for the selected city",
            expected_output='A comprehensive city guide',
            tools=[],
            agent=agent,
        )
