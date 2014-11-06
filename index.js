var _ = require('lodash'),
  Promise = require('bluebird'),
  logger

function isPromiseAlike( obj ){
  return _.isObject(obj) && _.isFunction(obj.then) && _.isFunction(obj.catch)
}

var nodes = {}

function makeCollectionName( modelName, relationDef ){
  var ns = []
  if( !relationDef.isMaster ){
    ns = ns.concat([modelName,relationDef.name])
    if( relationDef.reverse){
      ns = ns.concat([relationDef.model,relationDef.reverse.name])
    }
  }else{
      ns = ns.concat([relationDef.model,relationDef.reverse.name,modelName,relationDef.name])
  }
  return ns.join('_')
}

function generateAfterCreateCallback(modelName, relationDef, models) {
  var root = this
  return function handlerIndexAfterNodeCreate( newModel ) {
    if( !newModel[relationDef.name] ) return

    logger.log("detecting relation", relationDef.name)
    var relationModels = newModel[relationDef.name],
      relationCollection = makeCollectionName(modelName, relationDef),
      bus = this

    //1. validate multiple
    if( !relationDef.multiple && _.isArray( relationModels )) {
      return bus.error(406, 'relation not allow multiple for ' + relationDef.name + ' in ' + modelName)
    }

    //we make it an array just for convinience to use promise `all` method
    if( !_.isArray( relationModels ) ){
      relationModels = [relationModels]
    }

    return buildRelation.call(root,relationModels,relationDef,relationCollection,modelName,newModel,bus, models)
  }
}

function generateAfterUpdateCallback(modelName, relationDef, models) {
  var root = this
  return function handlerRelationAfterModelUpdate( updatedModels, criteria, updateObj ) {

    if( !updateObj[relationDef.name] ) return
    logger.log("updating relation", relationDef.name)

    var relationModels = updateObj[relationDef.name],
      relationCollection = makeCollectionName(modelName, relationDef),
      bus = this

    //1. validate multiple
    if( !relationDef.multiple && _.isArray( relationModels )) {
      return bus.error(406, 'relation not allow multiple for ' + relationDef.name + ' in ' + modelName)
    }

    //we make it an array just for convinience to use promise `all` method
    relationModels = [].concat(relationModels)

    //console.log("===========",relationModels,_.map(relationModels,function( relationModel){ return _.isObject( relationModel) ? relationModel.id : relationModel }))
    var relationsIds = _.uniq(_.compact(_.map(relationModels,function( relationModel){ return _.isObject( relationModel) ? relationModel.id : relationModel })).map(function(r){return r.toString()}))

    return Promise.all( updatedModels.map(function( updatedModel){

      return models[relationCollection].find(_.zipObject([modelName],[ updatedModel.id])).then(function( records ){
        var existsIds = _.pluck( records, relationDef.model).map(function(r){return r.toString()})
        var needDeleteRecordIds = _.without.apply( _, [existsIds].concat( relationsIds) )
        var notExistsRelationModels = _.filter(relationModels, function(model){
          var id = _.isObject(model) ? model.id : model
          return !id || existsIds.indexOf( id.toString()) ==-1
        })

        //console.log( records)
        //console.log( relationsIds,notExistsRelationModels, needDeleteRecordIds, existsIds)
        if( needDeleteRecordIds.length ){
          return models[relationCollection].destroy({id: needDeleteRecordIds}).then(function(){
            return buildRelation.call(root,notExistsRelationModels,relationDef,relationCollection,modelName,updatedModel,bus, models)
          })
        }else{
          return buildRelation.call(root,notExistsRelationModels,relationDef,relationCollection,modelName,updatedModel,bus, models)
        }

      })
    }))
  }
}


function buildRelation(relationModels,relationDef,relationCollection,modelName,modelIns,bus, models ){
  return Promise.all( relationModels.map(function ( relationModel ) {
    if( _.isString(relationModel) || _.isNumber(relationModel) ){
      relationModel = {id : relationModel}
    }

    //may need to build an new relation object
    //validate read write auth and create a new relation object
    if ( !relationModel.id && relationDef.auth.indexOf('write') !==-1 ) {
      //logger.log("relation","creating new relation object", relationDef, relationModel )

      return bus.fire( relationDef.model+".create", relationModel).then(function ( fireResult) {
        var savedRelationModal =fireResult['model.create.'+relationDef.model]
        //logger.log("relation"," create new relation object done ", savedRelationModal)
        //save the relation to relation collection
        return createRelationCollectionAndUpdateCaches(savedRelationModal,relationDef,relationCollection,modelName,modelIns,bus, models)
        //return bus.fire( relationCollection+".create", _.zipObject([modelName,relationDef.model],[modelIns.id,savedRelationModal.id]))
      })

    //user exist relation object
    }else if( relationModel.id){
      logger.log("index","use old relation", relationDef.name)

      //check if reverse model have multiple limit
      if( relationDef.reverse && !relationDef.reverse.multiple){
        var findRelationObj = {}
        findRelationObj[relationDef.model] = relationModel.id
        return bus.fire( relationCollection+".findOne", findRelationObj).then(function( fireResult){
          var foundRelation = fireResult['model.findOne'+relationCollection]
          if( foundRelation ){
            return logger.error("relation already exists", foundRelation)
          }else{
            return createRelationCollectionAndUpdateCaches(relationModel,relationDef,relationCollection,modelName,modelIns,bus, models)
            //return bus.fire( relationCollection+".create", _.zipObject([modelName,relationDef.model],[modelIns.id,relationModel.id]))
          }
        })
      }else{
        return createRelationCollectionAndUpdateCaches(relationModel,relationDef,relationCollection,modelName,modelIns,bus, models)
        //return bus.fire( relationCollection+".create", _.zipObject([modelName,relationDef.model],[modelIns.id,relationModel.id]))
      }

    }else{
      //ignore but continue
      return logger.error("you do not have right to create new relation object", relationModel)
    }
  }).filter( isPromiseAlike ))
}


function createRelationCollectionAndUpdateCaches( relationModel,relationDef,relationCollection,modelName,modelIns,bus, models){
  //create relation record
  return models[relationDef.model].findOne( relationModel.id).then(function( relationModel){
    return bus.fire( relationCollection+".create", _.zipObject([modelName,relationDef.model],[modelIns.id,relationModel.id])).then(function(createResult){

      var updateModelIns = _.pick( modelIns, [relationDef.name])
      if( relationDef.multiple ){
        updateModelIns[relationDef.name] = _.uniq((updateModelIns[relationDef.name]||[]).concat(relationModel.id))
      }else{
        updateModelIns[relationDef.name] = relationModel.id
      }
      //update cache to model
      return models[modelName].update(modelIns.id,updateModelIns).then(function(){
        var updateRelationModel = _.pick( relationModel,[relationDef.reverse.name])
        //update cache to relation model

        if( relationDef.reverse.multiple ) {
          updateRelationModel[relationDef.reverse.name] = _.uniq((updateRelationModel[relationDef.reverse.name] || []).concat(relationModel.id))
        }else{
          updateRelationModel[relationDef.reverse.name] = relationModel.id
        }
        return models[relationDef.model].update( relationModel.id, updateRelationModel)
      })
    })
  })
}


function generateBeforeModelFindHandler( modelName, relationDef, models){
  var relationCollection = makeCollectionName(modelName,relationDef)

  return {
    "function": function replaceRelationQueryWithIds( criteria ){
      //TODO change find criteria
      if( !criteria[relationDef.name] ) return

      var bus = this

      var replacePromise = models[relationDef.model].find(criteria[relationDef.name]).then(function( relationModels ){
        var relationIds = _.pluck( relationModels,"id")

        return models[relationCollection].find(_.zipObject([relationDef.model],relationIds)).then(function( relations){
          var modelIds = _.pluck( relations, modelName )
          if( criteria.id ){
            if(modelIds.indexof( criteria.id) == -1) return bus.error(404,"model not found with relations")
          }else{
            criteria.id = modelIds
          }
        })
      })

      replacePromise.block = true
      return replacePromise
    },
    "name" : "replaceRelation"+relationDef.name.replace(/^(\w)/,function(r){ return r.toUpperCase()})+"QueryWithIds",
    "first" : true
  }
}

function generateAfterModelFindHandler(modelName, relationDef,models){
  var relationCollection = makeCollectionName(modelName,relationDef)
  return {
    "function" : function fetchRelationObjects( records, criteria ){
      var bus = this

      if( !criteria.populate || criteria.populate.split(",").indexOf(relationDef.name) ==-1) return

      var ids = _.flatten(_.pluck( (_.isArray(records) ? records : [records]), "id" ))
      return bus.fire(relationCollection+".find", _.zipObject([modelName],[ids])).then(function( relationEventResults ){
        var relations = relationEventResults['model.find.'+relationCollection]
        var relationIds = _.pluck( relations, relationDef.model )

        return bus.fire(relationDef.model+".find",{id:relationIds}).then(function( relationModelResults){
          var relationModels = _.indexBy( relationModelResults['model.find.'+relationDef.model], "id")

          var relationIndexes = _.groupBy( relations, modelName )
          //console.log("found relation models", relationModels, relationIndexes)
          _.forEach((_.isArray(records) ? records : [records]), function(record){
            if( !relationIndexes[record.id] ) return

            if(relationDef.multiple ){
              record[relationDef.name] = relationIndexes[record.id].map(function( relation ){
                return relationModels[relation[relationDef.model]]
              })
            }else{
              //console.log( relationIndexes[record.id].pop() )
              var theRelation = relationIndexes[record.id].pop()
              if( theRelation  ){
                record[relationDef.name] = relationModels[theRelation[relationDef.model]]
              }
            }
          })
        })
      })
    },
    "name" : "fetchRelation" + relationDef.name.replace(/^\w/,function(r){return r.toUpperCase()})


  }
}


var relationModule = {
  indexes : {},
  listen : {},
  models : {},
  config : {
    connection : 'localDisk'
  },
  init : function(){
    logger = this.dep.logger
  },
  expand : function( module ){
    var root = this
    if( module.models ){
      module.models.forEach(function( model ){
        if( model.relations ){
          _.forEach(model.relations, function( relationDef, attrName){
            relationDef = _.defaults(relationDef,{
              //model : relation must have model
              name :attrName,
              auth : ['read'],
              multiple : false,
              isMaster : true
            })

            root.indexes[model.identity] = (root.indexes[model.identity] || []).concat(relationDef)

            if( relationDef.reverse ){
              var reverseRelationDef = _.defaults(_.cloneDeep(relationDef.reverse),{
                model : model.identity,
                //name : reverse must have a name
                auth : ['read'],
                reverse : {
                  name : relationDef.name,
                  model : relationDef.model
                },
                multiple : false
              })
              root.indexes[relationDef.model] = (root.indexes[relationDef.model]||[]).concat(reverseRelationDef)
            }

            var relationCollection = makeCollectionName(model.identity, relationDef)
            if( !root.models[relationCollection]){
              root.models[relationCollection] = {
                identity : relationCollection,
                attributes : {},
                connection : root.config.connection
              }
            }
          })
        }
      })
    }
  },
  bootstrap : {
    "function": function () {
      var root = relationModule,
        models = root.dep.model.models

      root.dep.model.expand(root)

      _.forEach(root.indexes, function (relationDefs, modelName) {
        _.forEach(relationDefs, function (relationDef) {

          root.dep.bus.on(modelName + '.create.after', generateAfterCreateCallback.call(root,modelName, relationDef, models))
          root.dep.bus.on(modelName + '.update.after',generateAfterUpdateCallback.call(root,modelName,relationDef, models ))
          root.dep.bus.on(modelName + '.find', generateBeforeModelFindHandler.call(root,modelName, relationDef, models))
          root.dep.bus.on(modelName + '.find.after', generateAfterModelFindHandler.call(root,modelName, relationDef, models))
          root.dep.bus.on(modelName + '.findOne.after', generateAfterModelFindHandler.call(root,modelName, relationDef, models))
        })
      })
    },
    "order" : {"before":"model.bootstrap"}
  }
}

module.exports = relationModule

