from crewai import Agent
from textwrap import dedent

from tools.calculator_tools import CalculatorTools
from tools.search_tools import SearchTools


class TripAgents:
    def city_selection_agent(self):
        return Agent(
            role="City Selection Expert",
            goal=dedent("Select the best city based on weather, season, and prices"),
            backstory="An expert in analyzing travel data to pick ideal destinations",
            tools=[
                SearchTools.search_internet,
                SearchTools.search_news,
            ],
            verbose=True,
        )

    def local_expert(self):
        return Agent(
            role='Local Expert at this city',
            goal='Provide the BEST insights about the selected city',
            backstory="""A knowledgeable local guide with extensive information
            about the city, its attractions and customs""",
            tools=[SearchTools.search_internet],
            verbose=True,
        )

    def helper(self):
        return "not an agent"

    def travel_concierge(self):
        return Agent(
            role="Amazing Travel Concierge",
            goal=dedent(
                """Create the most amazing travel itineraries with budget and
                packing suggestions for the city"""
            ),
            backstory="Specialist in travel planning and logistics",
            tools=[SearchTools.search_internet, CalculatorTools.calculate],
            verbose=True,
        )
