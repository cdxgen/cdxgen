from crewai import Agent, Crew, Process, Task
from crewai.project import CrewBase, agent, crew, task
from crewai_tools import SerperDevTool


@CrewBase
class ResearchCrew:
    """Research crew"""

    agents_config = "config/agents.yaml"
    tasks_config = "config/tasks.yaml"

    @agent
    def researcher(
        self,
    ) -> Agent:
        return Agent(
            config=self.agents_config["researcher"],
            role="Senior \"Data\" Researcher",
            tools=[SerperDevTool()],
            verbose=True,
        )

    @agent
    def reporting_analyst(self) -> Agent:
        return Agent(role="Reporting Analyst", goal=("Turn findings " "into reports"))

    @crew
    def crew(self) -> Crew:
        return Crew(agents=self.agents, tasks=self.tasks, process=Process.sequential)
