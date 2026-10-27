FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY src/RoadFun.Api/RoadFun.Api.csproj src/RoadFun.Api/
RUN dotnet restore src/RoadFun.Api/RoadFun.Api.csproj
COPY src/RoadFun.Api/ src/RoadFun.Api/
RUN dotnet publish src/RoadFun.Api/RoadFun.Api.csproj -c Release -o /publish --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
ENV ASPNETCORE_URLS=http://+:8080 ROADFUN_DATA_DIR=/data
RUN mkdir -p /data && chown -R app:app /data
COPY --from=build --chown=app:app /publish/ /app/
USER app
EXPOSE 8080
ENTRYPOINT ["dotnet","RoadFun.Api.dll"]
